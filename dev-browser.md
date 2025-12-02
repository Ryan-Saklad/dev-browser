# A Browser for Developers

I think there's a huge need for a web browser specifically tailored for developers and agents.

## Prior Art

Right now, there are tools like Cursor that support this to some degree. Cursor has an integrated browser that's connected to the editor, but it feels somewhat bolted on.

There are also collections of tools like the Playwright MCP, Playwright skill, Stagehand skill, and Stagehand MCPs. However, these aren't engineered to be the best solution for letting an agent quickly and efficiently debug browser interactions.

## Current Issues

There are several issues with existing solutions:

### Playwright MCPs

The main issue with Playwright MCPs is context bloat. They add around 30-40 tools that consume significant context window space. Additionally, because they read all existing HTML on the page, they consume even more context, making them inefficient and expensive to use.

### Playwright Skill

The Playwright skill is too far removed from the actual browser state. You're essentially having the agent write scripts and execute them, but there's no way to maintain the browser state between runs. This makes it difficult to make in-the-loop decisions. The workflow becomes: run script, fail, kill script, start again. While it's token-efficient, this iterative loop process makes it slow and inefficient for quickly solving problems.

### Stagehand Skill and MCP

I haven't used the Stagehand skill, but the main issue with the MCP is that it requires authentication with an extra account. If you bring your own keys, the LLM isn't doing the main driving, which makes it less cost-efficient.

## Proposed Solution

The solution will take the form of an npm package or CLI skill with a set of scripts for running browser interactions. It will be similar to the playwright skill but with the critical ability to maintain page states across interactions.

### Core Concept: Dev Browser

Dev Browser allows you to import and create pages that maintain state across scripts. An agent can write a script to start a page, then write another script to take a screenshot, and chain and compose tool calls to figure out what to do next.

### State Persistence

When you create a page using Dev Browser, it stays open and can be given a unique identifier. The agent can pick up and reuse this page in existing scripts or new scripts, providing continuity without having to start from scratch and rerun everything each time.

### Agent-Friendly Methods

It needs to learn from the tools that Do Browser and Stagehand provide. There should be more agent-friendly methods for interacting with the browser. This includes things like:

- A method to give a hybrid a11y tree / dom tree to the agent.
- A method to filter the elements that can be interacted with to the agent.
- A way to get an image of the page with all of the interactive elements highlighted.
- A way to eval code in the world of the browser.

### Credential Management

Dev Browser will have the ability to request usernames and passwords from the user, allowing it to log in without the LLM having to read or write secrets. A secret manager environment will help manage credentials and assist the agent in logging into sites.

### Interactive Browser Interface

It would also be interesting to have an actual browser interface attached that lets you select and interact with certain elements, allowing you to selectively add more context to the agent.

Code Example:

```typescript
import { devBrowser } from "dev-browser";

const browser = await devBrowser.getBrowser();

// Note that we can get a page that is already alive,
const page = await devBrowser.getPage("my-page");

page.goto("https://www.google.com");

const screenshot = await page.screenshot({ path: "screenshot.png" });
```
