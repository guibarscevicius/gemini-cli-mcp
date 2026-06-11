# Security Policy

> **⚠️ This project is deprecated and no longer actively maintained.** Security
> reports will not be actively triaged or fixed. The reporting channel below remains
> open so issues can be disclosed responsibly and recorded for anyone who forks the
> project, but do not expect a coordinated fix. See the README for context.

## Supported versions

No versions receive ongoing security maintenance. The last published release is the
final one; there is no rolling fix stream.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting to disclose the issue confidentially:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private advisory.

Please include:

- a description of the vulnerability and its impact,
- the steps or a proof of concept to reproduce it,
- the affected version(s) and any relevant environment details.

You will receive an acknowledgement of the report, and a fix or mitigation will be
coordinated privately before any public disclosure.

## Scope notes

gemini-cli-mcp spawns the external `gemini` CLI as a subprocess and exposes it over
the Model Context Protocol. When reporting, please distinguish between issues in this
project's own code (subprocess handling, session storage, MCP surface) and issues in
the upstream `@google/gemini-cli` tool, which should be reported to that project.
