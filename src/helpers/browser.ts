import { type Page } from 'puppeteer';

export async function maskHeadlessUserAgent(page: Page): Promise<void> {
  // Set a real Chrome user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );
  // Remove webdriver property to avoid detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

/**
 * Priorities for request interception. The higher the number, the higher the priority.
 * We want to let others to have the ability to override our interception logic therefore we hardcode them.
 */
export const interceptionPriorities = {
  abort: 1000,
  continue: 10,
};
