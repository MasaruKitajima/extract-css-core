const got = require('got')
const chromium = require('chrome-aws-lambda')
const normalizeUrl = require('normalize-url')
const isUrl = require('is-url')
const LRU = require('lru-cache')

const cssCache = new LRU({
	max: 500,
	maxAge: 60 * 1000
})

const extractCss = async url => {
	const browser = await chromium.puppeteer.launch({
		executablePath: await chromium.executablePath,
		args: chromium.args,
		headless: true
	})

	const page = await browser.newPage()

	// Start CSS coverage. This is the meat and bones of this module
	await page.coverage.startCSSCoverage()

	const response = await page.goto(url, { waitUntil: 'networkidle2' })

	// Make sure that we only try to extract CSS from valid pages.
	// Bail out if the response is an invalid request (400, 500)
	if (response.status() >= 400) {
		await browser.close() // Don't leave any resources behind

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
	// See: https://developer.mozilla.org/en-US/docs/Web/API/CSSRule/cssText
	const styleSheetsApiCss = await page.evaluate(() => {
		/* global document */
		return [...document.styleSheets]
			.filter(stylesheet => stylesheet.href === null)
			.map(stylesheet =>
				[...stylesheet.cssRules]
					.map(cssStyleRule => cssStyleRule.cssText)
					.join('')
			)
			.join('')
	})

	await browser.close()

	// Turn the coverage Array into a single string of CSS
	const coverageCss = coverage
		// Filter out the <style> tags that were found in the coverage
		// report since we've conducted our own search for them.
		// A coverage CSS item with the same url as the url of the page
		// we requested is an indication that this was a <style> tag
		.filter(styles => styles.url !== url)
		// The `text` property contains the actual CSS
		.map(({ text }) => text)
		.join('')

	return Promise.resolve(styleSheetsApiCss + coverageCss)
}

module.exports = async (req, res) => {
	const url = normalizeUrl(req.url.slice(1), { stripWWW: false })

	if (!isUrl(url)) {
		res.statusCode = 406
		res.setHeader('Content-Type', 'application/json')
		return res.end(
			JSON.stringify({
				message: 'The provided URL is not valid'
			})
		)
	}

	if (cssCache.has(url)) {
		res.setHeader('Content-Type', 'text/css')
		res.statusCode = 200
		return res.end(cssCache.get(url))
	}

	try {
		const css = url.endsWith('.css')
			? (await got(url)).body
			: await extractCss(url)

		res.setHeader('Content-Type', 'text/css')
		res.statusCode = 200
		cssCache.set(url, css)
		return res.end(css)
	} catch (error) {
		res.statusCode = 500
		res.setHeader('Content-Type', 'application/json')
		return res.end(JSON.stringify(error))
	}
}