'use strict';

const fs = require('fs');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const chalk = require('chalk');
const filesize = require('filesize');
const svgexport = require('svgexport');
const graphicsMagick = require('gm');

function magick(data, query) {
	return new Promise( (resolve, reject) => {
		var result = graphicsMagick(data);
		query.filter(Boolean).forEach(function(arg) {
			arg = arg.split("=");
			result = result.out("-"+arg.shift(), arg.join("="));
		});
		result.toBuffer( (err, res) => {
			if (err) {
				reject(err);
			} else {
				//console.log("magick ", hash(data), query, " > ", hash(res));
				resolve(res);
			}
		});
	});
}

function hash(data) {
	var h = crypto.createHash('sha256');
	h.update(data);
	return h.digest('base64').replace(/\+/g, '-').replace(/\//g, '_').substr(0,10);
}

// assets/my.svg?path{color:#fff;}&12x23
// assets/some.png?12x23
module.exports = function(bundle) {

	const scales = (bundle.platform === 'web' ? [2,1] : [3,2,1]);
	const assetDir = bundle.output.replace(/(\/|^)[^\/]*$/, '') || '.';

	const maxScale = scales[0];

	const resolve = (id) => {
		if (id.match(/^assets/) || id.match(/\.(png|jpg|svg|ttf)($|\?)/)) {
			return fs.existsSync(id.replace(/\?.*$/, '')) ? 'assets:'+id : undefined;
		}
	};

	const stats = {
		init() {
			this.files = 0;
			this.bytes = 0;
		},
		collect(stats) {
			const files = stats.reduce( (a,s) => a + s.files, 0 );
			const bytes = stats.reduce( (a,s) => a + s.bytes, 0 );
			console.log(`🎨  generated ${chalk.yellow(files + ' assets')}, ${chalk.gray(filesize(bytes))}`);
		}
	};

	const emit = (name, data) => {
		name = assetDir+'/'+name;
		const dir = name.replace(/\/[^\/]*$/, '');
		const file = name.replace(/^.*\//, '');
		mkdirp.sync(dir);
		fs.writeFileSync(name, data);

		stats.files++;
		stats.bytes += data.length;
	};

	const load = (id) => {
		if (!id.match(/^assets:/)) {
			return;
		}

		id = id.substr(7);

		let m = id.split('?');
		const file = m.shift(), query = m.join('?');

		m = file.replace(/^.*\//, '').split('.');
		let ext = m.pop(), name = m.join('');

		let data = fs.readFileSync(file); // as buffer
		if (!query) {
			emit(name+'.'+ext, data);
			return 'module.exports = ' + JSON.stringify({
				name: name,
				type: ext,
				asset: hash(data)
			}) + ';'
		}

		let query0 = query.split('&');
		let size = query0.pop().match(/^([0-9]+)x([0-9]+)$/);
		if (!size) {
			console.warn("asset should end with size, eg 'assets/my.png?12x34', got=" + id);
			return;
		}
		size = {width: +size[1], height: +size[2]}; // logical output size
		name += '_' + query.replace(/[^a-zA-Z0-9\-]+/g, '_');

		return new Promise( (accept, reject) => {
			let scales0 = [], assets = [];

			const process = (data, i) => {
				const scale = scales[i];
				const query1 = (i ? [] : query0).concat(
					// called recursively, only apply query operations the first time
					["resize=" + (size.width*scale) + "x" + (size.height*scale), "strip"]
				);
				magick(data, query1).then( (data0) => {
					emit(name + (scale === 1 ? '' : '@'+scale+'x') + '.' + ext, data0);
					scales0.unshift(scales[i]);
					assets.unshift(hash(data0));
					if (scales[i+1]) {
						process(data0, i+1);
					} else {
						accept('module.exports = ' + JSON.stringify({
							name: name,
							type: ext,
							width: size.width,
							height: size.height,
							scales: scales0,
							assets: assets
						}) + ';');
					}
				}).catch( (e) => {
					reject(e);
				});
			};

			if (ext === 'svg') {
				var args = [
					"/tmp/assetLoader" + (0|99999999*Math.random()),
					(size.width * maxScale) + ':' + (size.height * maxScale),
				];
				if (query0[0]) {
					// assets/my.svg?my{css:transform}&magick=op&12x34
					args.push(query0.shift()); // the css transform
				}
				ext = 'png';
				svgexport.render({
					input: [ file ],
					output: [ args ]
				}, (a) => {
					fs.readFile(args[0], (err, data) => {
						process(data, 0);
					});
				});
			} else {
				process(data, 0);
			}
		});
	};

	return { resolve, load, stats };
};
