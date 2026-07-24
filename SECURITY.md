# Security policy

## Reporting a vulnerability

Do not publish credentials, private keys, real server addresses or exploit
details in a public GitHub Issue.

Report security vulnerabilities privately to:

- 1829941918@qq.com

Include the affected version, operating system, reproduction conditions and
the minimum evidence needed to understand the issue. Remove or redact all
production credentials and personal data.

## Supported versions

Until a stable 1.0 release, security fixes are applied to the latest published
version only.

## Operational safety

Ops Flow Plus can execute commands, transfer files, modify databases, install
software, control services, change firewall rules and restore backups on
remote servers. Operators remain responsible for access control, target
selection, backups, command review and change approval.

Configuration export files can contain connection credentials when explicitly
requested. Protect their encryption passwords separately and delete temporary
copies after migration.
