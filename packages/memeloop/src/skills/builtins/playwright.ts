import type { SkillDefinition } from "../types.js";

/**
 * Playwright skill — browser automation via Playwright for verification,
 * browsing, information gathering, web scraping, testing, and screenshots.
 */
export const playwrightSkill: SkillDefinition = {
  id: "playwright",
  name: "Playwright",
  instructions: `You have access to Playwright for browser automation. Use it for:

Browser Automation:
- Navigate to URLs and verify page content
- Fill forms, click buttons, and interact with page elements
- Take screenshots of specific elements or full pages
- Extract data from web pages (scraping)
- Test web application functionality end-to-end
- Automate browser workflows
- Log into websites and maintain sessions

Best Practices:
- Use specific selectors (data-testid, id, or unique CSS selectors) over fragile XPath
- Wait for elements to be visible before interacting
- Handle page navigation and loading states explicitly
- Take screenshots at key steps for debugging
- Clean up browser resources when done
- Handle timeouts and error states gracefully

Available Playwright MCP Tools:
- browser_navigate: Navigate to a URL
- browser_click: Click an element
- browser_type: Type into an input field
- browser_snapshot: Take accessibility snapshot of page
- browser_take_screenshot: Capture screenshot
- browser_fill_form: Fill multiple form fields at once
- browser_evaluate: Execute JavaScript in page context
- browser_select_option: Select from dropdown
- browser_drag: Drag and drop elements
- browser_hover: Hover over an element
- browser_press_key: Press a keyboard key
- browser_handle_dialog: Handle browser dialogs (alert/confirm/prompt)
- browser_close: Close the browser`,
  tools: ["Read"],
  mcpServers: ["playwright"],
};
