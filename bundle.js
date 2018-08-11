#!/usr/bin/env node
const fs = require('fs');
const babel = require('babel-core');
const parseArgs = require('minimist');
const chalk = require('chalk');
const filesize = require('filesize');
const npmResolve = require('resolve');

const bundles = {};
	// master: bundle.id -> Bundle instance
	// workers: bundle.id -> bundleData (object with relevant fields only)

const pluginLoaders = {
	haste: hastePlugin,
	assets: (bundle) => require('./bundle-assets')(bundle)
};
const loadPlugin = (name, opts) => {
	return Object.assign({
		name: name,
		resolve: () => undefined,
		load: () => undefined,
		forkData: undefined,
		stats: undefined,
	}, pluginLoaders[name](opts));
};

class Bundle {

	constructor(opts) {
		this.output = opts.output;
		this.entry = opts.entry;
		this.platform = opts.platform;
		this.product = opts.product || opts.entry.split('/')[0].split('.')[0];
		this.release = opts.release;
		this.dev = !!opts.dev;

		this.extensions = [];
		[
			'.' + this.platform,
			(this.platform === 'ios' || this.platform === 'android') && '.native',
			'.react',
			''
		].filter( (e) => e !== false ).forEach( (e) => {
			this.extensions.push(e+'.tsx', e+'.ts', e+'.js', e+'.jsx');
		});

		this.id = this.output;

		const bundle0 = {
			id: this.id,
			output: this.output,
			entry: this.entry,
			platform: this.platform,
			product: this.product,
			release: this.release,
			dev: this.dev,
			extensions: this.extensions,
		};

		// load plugins
		this.plugins = (opts.plugins||[]).map( (name) => loadPlugin(name, bundle0) );
		bundle0.plugins = this.plugins.map( (plugin) => ({
			name: plugin.name,
			forkData: plugin.forkData
		}));

		bundles[this.id] = this;

		// let all workers know about this bundle
		workers.forEach( (w) => w.send({cmd: 'register', bundle: bundle0}) );
	}

	build() {
		this.compiled = {};
		// bundle lifetime: compile -> collectStats -> bundle -> finish
		return new Promise( (resolve,reject) => {
			this.onBuild = {resolve,reject};
			this.compile(this.entry)
		});
	}

	// compile schedules some compile work on a worker
	compile(path) {
		if (!this.startAt) {
			this.compileQ = 0;
			this.startAt = Date.now();
			workers.forEach( (w) => w.send({cmd: 'init', bundle: this.id}) );
		}
		this.compiled[path] = true;
		this.compileQ++;
		// find worker with smallest compile backlog
		const w = workers.reduce( (a,w) =>
			(a.compileQ||0) < (w.compileQ||0) ? a : w
		);
		w.compileQ = (w.compileQ||0)+1;
		w.send({cmd: 'compile', bundle: this.id, path});
	}

	onCompiled({worker, path, code, deps, error}) {
		// when worker is done
		if (error) {
			console.error("⚠️  " + error.message);
			if (error.codeFrame) {
				console.error(error.codeFrame);
			}
		}

		this.compiled[path] = {path, code, deps, error};
		// schedule to dependencies to compile
		(deps||[]).filter( (dep) => !this.compiled[dep] ).forEach( (dep) => this.compile(dep) );
		worker.compileQ--;
		this.compileQ--;
		if (this.onCompiledUnit) {
			this.onCompiledUnit({path,code,error});
		}
		if (!this.compileQ) {
			this.collectStats();
		}
	}

	resolve(id, importer) {
		// console.log('resolve', id, importer)
		if (id[0] === '.' && id !== './App' && id !== './app.json') {
			// always resolve relative paths first
			id = normalizePath(importer + '/../' + id);
		}
		console.log('resolve b', id, importer)

		if(id === 'AccessibilityInfo' && !importer){
			importer = 'node_modules/react-native/Libraries/react-native/react-native-implementation.js'
		}
		console.log('resolve a', id, importer)

		for (let p of this.plugins) {
			const path = p.resolve(id, importer);
			if (path) {
				return path;
			}
		}

		// Fix for the 'crypto' package
		if (id.endsWith('node_modules/uuid/lib/rng') || id.endsWith('node_modules/uuid/lib/sha1')) {
			// uuid module should use '-browser' variants. This is specified in the package, but we don't bother reading it.
			id += '-browser';
		}

		try {
			const platform = this.platform;
			let id0 = npmResolve.sync(id, {
				packageFilter(json) {
					if(json && json.sources && (platform==='ios' || platform==='android') && json.sources['react-native-v1']) {
						json.main = json.sources['react-native-v1'];
					}
					if(json && typeof json.browser === 'string' && platform==='web') {
						json.main = json.browser;
					}
					return json;
				},
				extensions: this.extensions
			});
			if (id0) {
				if (id0.startsWith(process.cwd() + '/')) {
					// npmResolve sometimes gives back absolute paths, convert back to relative
					id0 = id0.substr(process.cwd().length+1);
				}
				id = id0;
			}
		} catch (e) {}

		if (id.match(/\.([jt]sx?|json)$/)) {
			// path with extension
			return fs.existsSync(id) ? id : undefined;
		}

		// npmResolve.sync() above does not resolve directory imports properly, so add '/index.js' as workaround
		const ext = this.extensions.concat(['/index.js']).find( (ext) => fs.existsSync(id+ext) );
		if (ext) {
			return id+ext;
		}
	}

	load(path) {
		for (let p of this.plugins) {
			const code = p.load && p.load(path);
			if (code) { // might be a Promise, but if so it should return the code
				return code;
			}
		}

		if (path === 'void:') {
			return 'module.exports = {};';
		}
		if (path === 'node_modules/react-native/Libraries/Renderer/shims/ReactNativeFeatureFlags.js') {
			return 'module.exports = { useFiber: true };';
		}
		/*if (path.match(/PropTypes?.js$/)) {
			return 'module.exports = {};';
		}*/

		let code = fs.readFileSync(path, 'utf8');
		if (path === 'node_modules/warning/warning.js') {
			// warning.js contains a redefinition of __DEV__ based on process.env.NODE_ENV
			code = code.replace(/var __DEV__ =.*;/, '');
		}
		if(path === 'node_modules/admin-on-rest/lib/i18n/TranslationUtils.js') {
			// Fix dependency loop, just inline 'en' as default language
			code = code
				.replace('var _index = require(\'./index\');', '')
				.replace('_index.DEFAULT_LOCALE', '\'en\'')
		}
		if(path === 'node_modules/redux-saga/lib/internal/sagaHelpers/takeEvery.js'
				|| path === 'node_modules/redux-saga/lib/internal/sagaHelpers/takeLatest.js'
				|| path === 'node_modules/redux-saga/lib/internal/sagaHelpers/throttle.js') {
			// Fix dependency loops, move require to the place it is actually used
			code = code
				.replace('var _io = require(\'../io\');', '')
				.replace(/_io\./g, 'require(\'../io\').');
		}
		if(path === 'node_modules/react-virtualized/dist/commonjs/Grid/types.js') {
			// Fix dependency loop
			code = code.replace("var _ScalingCellSizeAndPositionManager = require('./utils/ScalingCellSizeAndPositionManager');", 'var _ScalingCellSizeAndPositionManager = {};')
		}

		/*if (path === 'config.json') {
			// filter keys starting with _ in config.json
			let config = JSON.parse(code);
			Object.keys(config).filter( (k) => k[0] === '_' ).forEach( (k) => {
				delete(config[k]);
			});
			code = JSON.stringify(config);
		}*/
		if (path.match(/\.json$/)) {
			code = 'module.exports = '+code+';';
		}
		return code;
	}

	compileWork(path) {
		return Promise.resolve(this.load(path)).then( (code) => {
			if (typeof code !== 'string') {
				throw new Error("cannotLoad:"+path);
			}

			/*if (path.match(/\.tsx?$/)) {
				// typescript to es6
				code = require('typescript').transpileModule(code, {
					fileName: path,
					transpileOnly: true,
					compilerOptions: {
						target: 'esnext',
						jsx: 'preserve',
					}
				}).outputText;
			}*/

			const deps = [];
			const isJSC = (this.platform === 'ios' || this.platform === 'android');
			const isNPM = path.indexOf('node_modules') >= 0;
			const isRN = path.indexOf('node_modules/react-native/') >= 0;

			let babeled = babel.transform(code, {
				filename: path,
				babelrc: false,
				plugins: [
					(ctx) => conditionalCode(ctx, this.platform, this.product, this.release, this.dev),

					['transform-es2015-modules-commonjs', {strict: false, strictMode: false, allowTopLevelThis: true}],
					(ctx) => collectDeps(ctx, deps, (id) => this.resolve(id, path) ),

					isRN && 'transform-flow-strip-types',

					// esNext:
					['transform-class-properties', {loose: true}],
					'transform-object-rest-spread',
					'transform-react-jsx',
					'transform-decorators-legacy',

					// es2015:
					'transform-es2015-arrow-functions',
					'transform-es2015-block-scoped-functions',
					'transform-es2015-block-scoping',
					['transform-es2015-classes', {loose: true}],
					'transform-es2015-computed-properties',
					'transform-es2015-destructuring',
					'transform-es2015-duplicate-keys',
					!isJSC && 'transform-es2015-for-of',
					'transform-es2015-function-name',
					'transform-es2015-object-super',
					'transform-es2015-parameters',
					'transform-es2015-shorthand-properties',
					'transform-es2015-spread',
					'transform-es2015-sticky-regex',
					'transform-es2015-template-literals',
					'transform-es2015-typeof-symbol',
					'transform-es2015-unicode-regex',
					'transform-es2015-literals',
					'async-to-promises',
				].filter(Boolean),
				presets: [
					//isRN && isNodeModule && 'react-native',
				].filter(Boolean)
			});
			code = babeled.code;

			return {code, deps};
		});
	}

	collectStats() {
		this.stats = {};
		workers.forEach( (w) => w.send({cmd: 'stats', bundle: this.id}) );
		this.collectQ = workers.length;
	}

	onStats({stats}) {
		//console.log('onStats', stats);
		if (!this.stats) { // parallel runs
			this.stats = {};
		}
		Object.keys(stats).map( (name) => {
			if (!this.stats[name]) {
				this.stats[name] = [];
			}
			this.stats[name].push(stats[name]);
		});
		this.collectQ--;
		if (!this.collectQ) {
			Object.keys(this.stats).forEach( (name) => {
				this.plugins.find( (p) => p.name === name ).stats.collect(this.stats[name]);
			});
			this.bundle();
		}
	}

	bundle() {
		try {
			const visited = {}, ordered = [];
			const visit = (path, stack) => {
				if (visited[path] === false) {
					console.warn(`⚠️  ${chalk.bgRed("dependency cycle")} ${stack.slice(stack.indexOf(path)).concat([path]).join(" -> ")}`);
					return;
				}
				if (visited[path]) {
					return;
				}

				const unit = this.compiled[path];
				if (!unit) {
					// this shouldn't happen..
					const e = new Error('missing');
					e.path = unit.path;
				} else if (unit.error) {
					unit.error.path = unit.path;
					throw unit.error;
				}
				const stack0 = stack.concat([path]);
				visited[path] = false;
				(unit.deps||[]).forEach( (p) => visit(p, stack0) );
				visited[path] = true;

				ordered.push({
					path: unit.path,
					code: unit.code,
					depth: stack0.length-1
				});
			};
			visit(this.entry, []);

			let moduleIndex = (path) => JSON.stringify(path);
			if (!this.dev) {
				moduleIndex = (path) => {
					moduleIndex[path] = ++moduleIndex._n;
					return moduleIndex._n;
				};
				moduleIndex._n = 0;
			}

			var modulesAt = 1;

			const moduleCode = definer.toString().match(/{([\s\S]*)}/)[1];
			let code = prelude.toString().match(/{([\s\S]*)}/)[1]
				+ ordered.map( ({path,code}) =>
					moduleCode
						.replace('$id$', () => moduleIndex(path))
						.replace('$code$;', () => code)
				).join("\n")
				+ 'require('+JSON.stringify(moduleIndex[this.entry] || this.entry)+');';

			const bundledAt = Date.now();
			console.log(`🎯  bundled ${chalk.green(this.output)} (product=${this.product} platform=${this.platform} dev=${this.dev}), ${filesize(code.length)} in ${bundledAt - this.startAt}ms`);

			if (!this.dev) {
				const UglifyJS = require('uglify-es');
				const uglified = UglifyJS.minify(code, {
					output: {ast: true, code: false},
					//compress: { inline: 1 }
				});
				if (uglified.error) {
					uglified.error.path = 'uglify';
					throw uglified.error;

				} else {
					const ast = uglified.ast.transform(new UglifyJS.TreeTransformer( (node, descend) => {
						if (node instanceof UglifyJS.AST_Call && node.expression.name === 'require' && node.args.length === 1) {
							const id = moduleIndex[node.args[0].value];
							if (id) {
								node.args[0] = new UglifyJS.AST_Number({
									value: id,
									start: node.args[0].start,
									end: node.args[0].end
								});
								return node;
							}
						}
						return undefined;
					}));
					code = ast.print_to_string();
					const minifiedAt = Date.now();
					console.log(`🔥  minified to ${filesize(code.length)} in ${minifiedAt - bundledAt}ms`);
				}
			}

			fs.writeFileSync(this.output, code);

			fs.writeFileSync(this.output.replace(/\.js$/, '') + '.deps',
				ordered.map( ({path,code,depth}) => [
					Array(depth*2).join(' '),
					path,
					filesize((code||'').length)
				].join(' ') ).join("\n") );

			if (this.onBundled) {
				this.onBundled(true);
			}
			if (this.onBuild) {
				this.onBuild.resolve();
				this.onBuild = false;
			}

		} catch (e) {
			console.error("⚠️ ", e.path, e.message);
			if (this.onBundled) {
				this.onBundled(false, e);
			}
			if (this.onBuild) { 
				this.onBuild.reject();
				this.onBuild = false;
			}
		}

		this.startAt = false;
		this.stats = false;
		// keep this.compiled cache!
	}
}

if (process.send) {
	// we are a child worker
	process.on('message', (msg) => {
		const {cmd, bundle} = msg;
		if (cmd === 'register') {
			// bundle registration, bundle should be object
			let plugins = bundle.plugins;
			delete bundle.plugins;
			bundle.plugins = plugins.map( ({name,forkData}) =>
				loadPlugin(name, Object.assign({forkData}, bundle))
			);
			bundle.resolve = Bundle.prototype.resolve;
			bundle.load = Bundle.prototype.load;
			bundle.compileWork = Bundle.prototype.compileWork;
			bundles[bundle.id] = bundle;

		} else if (cmd === 'init') {
			bundles[bundle].plugins.filter( (p) => p.stats ).forEach( (p) => {
				p.stats.init();
			});

		} else if (cmd === 'stats') {
			const stats = {};
			bundles[bundle].plugins.filter( (p) => p.stats ).forEach( (p) => {
				const s = Object.assign({}, p.stats);
				delete(s.init, s.collect);
				stats[p.name] = s;
			});
			process.send({cmd: 'onStats', bundle, stats});

		} else if (cmd === 'compile') {
			const {path} = msg;
			bundles[bundle].compileWork(path)
				.then( ({code, deps}) => {
					process.send({cmd: 'onCompiled', bundle, path, code, deps});
				})
				.catch( (error) => {
					process.send({cmd: 'onCompiled', bundle, path, error: {
						message: error.message, // pull from getter
						...error
					}});
				});
		}
	});
	return;
}

// master process

let workers = [];

function startWorkers(n) {
	const child_process = require('child_process');
	workers = Array(n).fill(true).map( (q, i) => {
		const worker = child_process.fork(__filename);
		worker.on('message', (msg) => {
			msg.worker = worker;
			bundles[msg.bundle][msg.cmd](msg);
		});
		return worker;
	});
}

function stopWorkers() {
	workers.forEach( (c) => c.kill() );
}


if (require.main === module) {
	// invoked from command line, compile a single Bundle
	const opts = {
		output: '',
		entry: '',
		platform: '',
		product: '',
		release: 'dev',
		workerN: 4
	};

	Object.assign(opts, parseArgs(process.argv.slice(2), {string: Object.keys(opts).filter( (k) => typeof opts[k] === 'string' )}));

	if (!opts.output || !opts.entry || !opts.platform) {
		console.log(`usage: ${process.argv[1]} --output=build/app.js --entry=app.js --platform=web`);
		process.exit(1);
	}

	startWorkers(opts.workerN);
	new Bundle({
		output: opts.output,
		entry: opts.entry,
		platform: opts.platform,
		product: opts.product,
		release: opts.release,
		dev: (opts.release === 'dev'),
		plugins: ['assets', 'haste']
	}).build()
		.then( stopWorkers )
		.catch( () => {
			stopWorkers();
			process.exit(24);
		});

} else {
	// loaded as library
	exports.Bundle = Bundle;
	exports.startWorkers = startWorkers;
	exports.stopWorkers = stopWorkers;
}

// templates
function prelude() {
	var global = this, self = this,
		modules = global.modules = {},
		defines = global.defines = {};
	function require(name) {
		if (modules[name] === undefined) {
			if (defines[name] === undefined) {
				throw new Error('noSuchModule:'+name);
			}
			modules[name] = defines[name]();
			delete(defines[name]);
		}
		return modules[name];
	}
}

function definer() {
	defines[$id$] = function() {
		var module = {exports: {}}, exports=module.exports;
		$code$;
		return module.exports;
	};
}

function walkDir(path, cb) {
	const stat = fs.statSync(path);
	if (stat.isFile() && path.endsWith('.js')) {
		cb(path);
	} else if (stat.isDirectory()) {
		fs.readdirSync(path).forEach(function(path0) {
			if ([ // blacklist
				'node_modules', '__tests__', '__mocks__',
				'__fixtures__', 'react-packager', 'androidTest'
			].indexOf(path0) >= 0) {
				return;
			}
			walkDir(path+'/'+path0, cb);
		});
	}
}

// normalizePath normalizes . and .. instances in pathnames through a simple regex
function normalizePath(path) {
	while (true) {
		const n = path.replace(/\/\.\//, '/').replace(/\/[^\/]+\/\.\.\//, '/');
		if (n === path) {
			return path;
		}
		path = n;
	}
}

// A babel pass to collect require('string') calls
function collectDeps({types: t}, deps, resolve) {
	return {
		visitor: {
			CallExpression: {
				exit(p) {
					if (p.node.callee.name === 'require' && p.node.arguments[0] && p.node.arguments[0].type === 'StringLiteral') {
						const name = p.node.arguments[0].value;
						if (p.node.__collected) {
							return;
						}
						const path = resolve(name);
						console.log('resolve', name, path)
						if (!path) {
							throw p.buildCodeFrameError("cannotResolve:"+name);
						}
						p.node.__collected = true;
						p.node.arguments[0].value = path;
						if (deps.indexOf(path) < 0) {
							deps.push(path);
						}
					}
				}
			}
		}
	};
}

// A simple/fast pass to remove conditionals behind __DEV__, __PLATFORM__ and process.env.NODE_ENV.
function conditionalCode({types: t}, platform, product, release, dev) {
	const binaryOps = {
		'&&': (a,b) => a && b,
		'||': (a,b) => a || b,
		'!==': (a,b) => a !== b,
		'===': (a,b) => a === b,
		'!=': (a,b) => a != b,
		'==': (a,b) => a == b
	};
	const isLiteral = (node) =>
		/Literal$/.test(node.type) ||
		(node.type === 'Identifier' && node.name === 'undefined');

	const collapseTestVisitor = {
		Identifier(p) {
			if (p.node.name === '__PLATFORM__') {
				p.replaceWith(t.StringLiteral(platform));
			} else if (p.node.name === '__PRODUCT__') {
				p.replaceWith(t.StringLiteral(product));
			} else if (p.node.name === '__RELEASE__') {
				p.replaceWith(t.StringLiteral(release));
			} else if (p.node.name === '__DEV__') {
				p.replaceWith(t.BooleanLiteral(!!dev));
			}
		},
		MemberExpression(p) {
			if (p.matchesPattern('process.env.NODE_ENV')) {
				p.replaceWith(t.StringLiteral(dev ? 'development' : 'production'));
			}
		},
		UnaryExpression: {
			exit(p) {
				if (p.node.operator === '!' && isLiteral(p.node.argument)) {
					// !true -> false, !false -> true
					p.replaceWith(t.BooleanLiteral(!p.node.argument.value));
				}
			}
		},
		'BinaryExpression|LogicalExpression': {
			exit(p) {
				if (binaryOps[p.node.operator] && isLiteral(p.node.left) && isLiteral(p.node.right)) {
					p.replaceWith(t.booleanLiteral(
						binaryOps[p.node.operator](p.node.left.value, p.node.right.value)
					));
				} else if (p.node.operator === '&&' && isLiteral(p.node.left) && p.node.left.value === false) {
					p.replaceWith(t.booleanLiteral(false));
				} else if (p.node.operator === '||' && isLiteral(p.node.left) && p.node.left.value === true) {
					p.replaceWith(t.booleanLiteral(true));
				}
			}
		}
	};

	return {
		visitor: {
			'IfStatement|ConditionalExpression'(p) {
				// Essential is that we're evaluating the branches on "enter", so
				// other plugins don't need to traverse the tree of branches not taken.
				// We need an extra visitor to evaluate the if's test.
				// p.get('test').traverse(collapseTestVisitor) does not include the root, workaround:
				babel.traverse.explode(collapseTestVisitor);
				babel.traverse.node(p.node, collapseTestVisitor, p.scope, undefined, p, { consequent: true, alternate: true });

				if (p.node.test.type === 'BooleanLiteral') {
					// leaves a lexical scope, but oh well
					if (p.node.test.value) {
						p.replaceWith(p.node.consequent);
					} else if (p.node.alternate) {
						p.replaceWith(p.node.alternate);
					} else {
						p.remove();
					}
					//console.log("collapsed if");
				}
			},
			// Catch remaining refs such as: console.log("Dev: ", __DEV__);
			Identifier: collapseTestVisitor.Identifier,
			MemberExpression: collapseTestVisitor.MemberExpression
		}
	};
}

// hastePlugin

function hastePlugin(bundle) {

	let hasteMap = bundle.forkData;
	if (!hasteMap) {
		scan = (path) => {
			walkDir(path, (path) => {
				console.log('walkdir', path)
				var s = path.replace(/^(.*)\//, '').split('.');
				if (bundle.extensions.indexOf('.'+s.slice(1).join('.')) < 0) {
					console.log('no pass')
					return;
				}
				// const code = fs.readFileSync(path, 'utf-8');
				// const name = (code.match(/\* @providesModule (.+)/)||[])[1];
				const i = path.split('/')
				let name = i[i.length-1].replace('.js', '')

				const ext = name.split('.')
				console.log('ext', ext[ext.length - 1])
				if(ext[ext.length - 1] === 'ios'){
					name = ext.slice(0, ext.length-1).join('.')
				}

				console.log({name})
				if (name && (hasteMap[name]||'').length < path.length) {
					hasteMap[name] = path;
				}
			});
		};
		hasteMap = {};
		scan('node_modules/react-native/Libraries');
		scan('node_modules/react-native/lib');
		console.log(hasteMap)
		console.log(`🍭  collected hasteMap: ${Object.keys(hasteMap).length} modules`);
	}

	const resolve = (id) => {
		if (hasteMap[id]) {
			// haste module, such as 'NativeEventEmitter'
			if (id === 'InitializeCore') {
				// we do our own env init in app/init.js, no react-native/Libraries/Core/InitializeCore.js
				return 'void:';
			}
			/*if (['ReactNativeART', 'NavigatorIOS', 'PermissionsAndroid', 'Picker'].indexOf(id) >= 0) {
				return 'void:';
			}*/
			if (!bundle.dev && ['YellowBox'].indexOf(id) >= 0) {
				return 'void:';
			}
			/*if (id === 'ReactNative') {
				// wire Libraries/Renderer/shims/ReactNative.js directly to proper fiber renderer
				// we can remove this if we're properly compiling 'ReactNativeFeatureFlags.useFiber' away
				id = 'ReactNativeRenderer-' + (bundle.dev ? 'dev' : 'prod');
			}*/
			return hasteMap[id];
		}
	};

	const forkData = hasteMap;

	return { resolve, forkData };
}
