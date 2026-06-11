# Security Policy

## Supported versions

This project follows a rolling release model: security fixes land on the latest
published version. Please upgrade to the most recent release before reporting an
issue you cannot reproduce there.

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
