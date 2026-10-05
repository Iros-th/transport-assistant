import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        
        # Desktop
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        await page.goto("http://localhost:8000")
        # Fill in the form and submit
        await page.fill("#origin", "Nørreport St.")
        await page.fill("#destination", "DTU Lyngby")
        await page.click("#plan-submit")
        await page.wait_for_timeout(5000) # wait for map and apis
        await page.screenshot(path="desktop.png")
        await page.close()
        
        # Mobile
        mobile_page = await browser.new_page(viewport={"width": 375, "height": 812}, is_mobile=True, user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1")
        await mobile_page.goto("http://localhost:8000")
        await mobile_page.fill("#origin", "Nørreport St.")
        await mobile_page.fill("#destination", "DTU Lyngby")
        await mobile_page.click("#plan-submit")
        await mobile_page.wait_for_timeout(5000)
        await mobile_page.screenshot(path="mobile.png")
        await mobile_page.close()
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
