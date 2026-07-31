# Security policy

## Reporting a vulnerability

Do not publish credentials, private keys, real server addresses or exploit
details in a public GitHub Issue.

Report security vulnerabilities privately to:

- 734052482@qq.com

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

The optional legacy Dameng compatibility mode permits older cryptographic
algorithms only inside a dedicated external Node.js child process. The process
receives the selected `dmdb` path and connection credentials over local IPC,
does not log them, and exits after the database operation. This mode does not
change the application's configuration encryption or other database
connections. Enable it only for older servers that cannot yet be upgraded, and
select only a trusted official Node.js runtime and a lawfully obtained official
Dameng driver.
