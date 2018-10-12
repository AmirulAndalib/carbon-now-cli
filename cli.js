#!/usr/bin/env node

// Native
const {promisify} = require('util');
const {basename, extname} = require('path');
const asyncRename = promisify(require('fs').rename);

// Packages
const meow = require('meow');
const chalk = require('chalk');
const opn = require('opn');
const queryString = require('query-string');
const terminalImage = require('terminal-image');
const generate = require('nanoid/generate');
const Listr = require('listr');

// Source
const processContent = require('./src/process-content.js');
const getLanguage = require('./src/get-language.js');
const headlessVisit = require('./src/headless-visit.js');
const interactiveMode = require('./src/interactive-mode.js');
const presetHandler = require('./src/preset.js');

// Helpers
const {CARBON_URL, LATEST_PRESET} = require('./src/helpers/globals');
let settings = require('./src/helpers/default-settings');

const cli = meow(`
 ${chalk.bold('Usage')}
   $ carbon-now <file>

 ${chalk.bold('Options')}
   -s, --start          Starting line of <file>
   -e, --end            Ending line of <file>
   -i, --interactive    Interactive mode
   -l, --location       Image save location, default: cwd
   -t, --target         Image name, default: original-hash.{png|svg}
   -o, --open           Open in browser instead of saving
   -p, --preset         Use a saved preset
   -h, --headless       Use only non-experimental Puppeteer features
   --config             Use a different, local config (read-only)

 ${chalk.bold('Examples')}
   See: https://github.com/mixn/carbon-now-cli#examples
`,
{
	flags: {
		start: {
			type: 'number',
			alias: 's',
			default: 1
		},
		end: {
			type: 'number',
			alias: 'e',
			default: 1000
		},
		open: {
			type: 'boolean',
			alias: 'o',
			default: false
		},
		location: {
			type: 'string',
			alias: 'l',
			default: process.cwd()
		},
		target: {
			type: 'string',
			alias: 't',
			default: null
		},
		interactive: {
			type: 'boolean',
			alias: 'i',
			default: false
		},
		preset: {
			type: 'string',
			alias: 'p',
			default: LATEST_PRESET
		},
		config: {
			type: 'string',
			default: undefined // So that default params trigger
		},
		headless: {
			type: 'boolean',
			alias: 'h',
			default: false
		}
	}
});
const [file] = cli.input;
const {start, end, open, location, target, interactive, preset, config, headless} = cli.flags;
let url = CARBON_URL;

// Deny everything if not at least one argument (file) specified
if (!file) {
	console.error(`
  ${chalk.red('Error: Please provide at least a file.')}

  $ carbon-now <file>
	`);
	process.exit(1);
}

// Run main CLI programm
(async () => {
	// If --preset given, take that particular preset
	if (preset) {
		settings = {
			...settings,
			...(await presetHandler.get(preset, config))
		};
	}

	// If --interactive, enter interactive mode and adopt settings
	// This unfortunately can’t be inside of Listr since it leads to rendering problems
	if (interactive) {
		settings = {
			...settings,
			...(await interactiveMode())
		};
	}

	// Prepare tasks
	const tasks = new Listr([
		// Task 1: Process and encode file
		{
			title: `Processing ${file}`,
			task: async ctx => {
				try {
					const processedContent = await processContent(file, start, end);
					ctx.encodedContent = encodeURIComponent(processedContent);
				} catch (error) {
					return Promise.reject(error);
				}
			}
		},
		// Task 2: Merge all given settings (default, preset, interactive), prepare URL
		{
			title: 'Preparing connection',
			task: async ({encodedContent}) => {
				// Save the current settings as 'latest-preset' to global config
				// Don’t do so for local configs passed via --config
				// The `save` method takes care of whether something should
				// also be saved as a preset, or just as 'latest-preset'
				if (!config) {
					await presetHandler.save(settings.preset, settings);
				}

				// Add code and language, irrelevant for storage and always different
				settings = {
					...settings,
					code: encodedContent,
					l: getLanguage(file)
				};

				// Prepare the querystring that we’ll send to Carbon
				url = `${url}?${queryString.stringify(settings)}`;
			}
		},
		// Task 3: Only open the browser if --open
		{
			title: 'Opening in browser',
			skip: () => !open,
			task: () => {
				opn(url);
			}
		},
		// Task 4: Download image to --location if not --open
		{
			title: 'Fetching beautiful image',
			skip: () => open,
			task: async ctx => {
				const {type} = settings;
				const	original = basename(file, extname(file));
				const downloaded = `${location}/carbon.${type}`;
				const fileName = target || `${original}-${generate('123456abcdef', 10)}`;
				const saveAs = `${location}/${fileName}.${type}`;

				// Fetch image and rename it
				await headlessVisit(url, location, type, headless);
				await asyncRename(downloaded, saveAs);

				ctx.savedAs = saveAs;
			}
		}
	]);

	// Run tasks
	// I like the control-flow-iness of .then() and .catch() here
	// and prefer it to async/await in this case… go ahead, JUDGE ME
	tasks
		.run()
		.then(async ({savedAs}) => {
			console.log(`
  ${chalk.green('Done!')}`
			);

			if (open) {
				console.log(`
  Browser opened — finish your image there! 😌`
				);
			} else {
				console.log(`
  The file can be found here: ${savedAs} 😌`
				);

				if (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM.match('iTerm')) {
					console.log(`
  iTerm2 should display the image below. 😊

		${await terminalImage.file(savedAs)}`
					);
				}
			}

			process.exit();
		})
		.catch(error => {
			console.error(`
  ${chalk.red('Error: Sending code to https://carbon.now.sh went wrong.')}

  This is mostly due to:

  – Insensical input like \`--start 10 --end 2\`
  – Carbon being down or taking too long to respond
  – Your internet connection not working or being too slow

  Additional info:

  ${error}`);

			process.exit(1);
		});
})();
