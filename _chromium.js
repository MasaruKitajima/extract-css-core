/* global document */

const puppeteer = require('puppeteer-core')
const chrome = require('chrome-aws-lambda')
const crypto = require('crypto')
const exePath =
	process.platform === 'win32' ?
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' :
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const isDev = process.env.NOW_REGION === 'dev1'

async function getOptions() {
	if (isDev) {
		return {
			args: [],
			executablePath: exePath,
			headless: true
		}
	}

	return {
		args: chrome.args,
		executablePath: await chrome.executablePath,
		headless: chrome.headless
	}
}

function hashString(str) {
	return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

// Keep a locally cached 'page' object so that we
// don't have to request the browser instance to
// create a new one for each request.
let _page

async function getPage() {
	if (_page) {
		return _page
	}

	const options = await getOptions()
	const browser = await puppeteer.launch(options)
	_page = await browser.newPage() // eslint-disable-line
	return _page
}

exports.extractCss = async url => {
	const page = await getPage()

	// Start CSS coverage. This is the meat and bones of this module
	await page.coverage.startCSSCoverage().catch(() => {})

	const response = await page.goto(url, {waitUntil: 'networkidle0'})

	// Make sure that we only try to extract CSS from valid pages.
	// Bail out if the response is an invalid request (400, 500)
	if (response.status() >= 400) {
		return Promise.reject(
			new Error(
				`There was an error retrieving CSS from ${url}.\n\tHTTP status code: ${response.statusCode} (${response.statusText})`
			)
		)
	}

	// Coverage contains a lot of <style> and <link> CSS,
	// but not all...
	const coverage = await page.coverage.stopCSSCoverage()

	// Get all CSS generated with the CSSStyleSheet API
	// This is primarily for CSS-in-JS solutions
	// See: https://developer.mozilla.org/en-US/docs/Web/API/CSSRule/cssText
	const styleSheetsApiCss = await page.evaluate(() => {
		return [...document.styleSheets]
			.filter(stylesheet => stylesheet.href === null)
			.map(stylesheet =>
				[...stylesheet.cssRules]
					.map(cssStyleRule => cssStyleRule.cssText)
					.join('\n')
			)
			.join('\n')
	})

	// Get all inline styles: <element style="">
	// This creates a new CSSRule for every inline style
	// attribute it encounters.
	//
	// Example:
	//
	// HTML:
	//    <h1 style="color: red;">Text</h1>
	//
	// CSSRule:
	//    [x-inline-style-237a7d] { color: red; }
	//                    ^^^^^^
	//
	// The 6-digit hash is based on the actual CSS, so it's not
	// necessarily unique!
	const inlineCssRules = await page.evaluate(() => {
		return [...document.querySelectorAll('[style]')]
			.map(element => element.getAttribute('style'))
			.filter(Boolean)
	})
	const inlineCss = inlineCssRules
		.map(rule => {
			const hash = hashString(rule).slice(-6)
			return `[x-inline-style-${hash}] { ${rule} }`
		})
		.join('\n')

	// Turn the coverage Array into a single string of CSS
	const coverageCss = coverage
		// Filter out the <style> tags that were found in the coverage
		// report since we've conducted our own search for them.
		// A coverage CSS item with the same url as the url of the page
		// we requested is an indication that this was a <style> tag
		.filter(styles => styles.url !== url)
		// The `text` property contains the actual CSS
		.map(({text}) => text)
		.join('\n')

	const css = [coverageCss, styleSheetsApiCss, inlineCss]
		.filter(Boolean)
		.join('\n')

	return Promise.resolve(css)
}
