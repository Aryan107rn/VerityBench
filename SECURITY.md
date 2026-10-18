# Security policy

VerityBench is an evaluation platform and treats agent code, tool output,
repositories, logs, and model responses as untrusted. The MVP deliberately
does not execute user-supplied code or access user-provided URLs.

## Reporting a vulnerability

Do not open a public issue for a suspected security vulnerability. Contact the
repository maintainers through the private security channel configured for the
deployment, including reproduction steps, affected commit, impact, and a
harmless proof of concept. Do not include credentials or personal data.

## Security assumptions and limits

- Passwords are Argon2-hashed; bearer sessions are opaque and stored server-side
  as hashes with expiry and revocation.
- Every protected project and run lookup checks the authenticated owner's ID.
- The in-memory rate limiter is suitable only for a single local instance.
- Ordinary Docker containers are not considered a complete hostile-code
  boundary. A stronger sandbox is required before imported agents are enabled.
- Scanner output is evidence about the scanned scope, not a guarantee of zero
  vulnerabilities.
