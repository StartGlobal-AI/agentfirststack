# Security policy

AgentFirstStack runs a public, free hosted service at agentfirststack.com, so we take reports
seriously and fix them quickly.

## Reporting a vulnerability

Please don't open a public issue. Report privately, either way:

- GitHub: **Security > Report a vulnerability** on this repository (private advisory), or
- Email: **security@agentfirststack.com**

Include what you found, how to reproduce it, and the impact you think it has. You'll get an
acknowledgement within 3 working days and a plan within 10. We'll tell you when it's fixed and
credit you in the release notes unless you'd rather we didn't.

## Scope

- The code in this repository.
- The hosted deployment at agentfirststack.com and its subdomains.

Out of scope: volumetric denial of service, findings that need a compromised Cloudflare account,
and reports from automated scanners without a demonstrated impact.

## Testing the hosted service

Use your own accounts and resources only. Don't access other users' data, send email to people
who haven't agreed to it, or degrade the service for others. Research that follows these rules is
welcome, and we won't pursue it.

## Supported versions

Fixes go into `main` and are deployed to the hosted service right away. Self-hosters should
update to the latest release (see [docs/self-hosting.md](docs/self-hosting.md#update)).
