# Third-party notices

Ops Flow Plus contains or depends on third-party software. Those components
remain governed by their own licenses; MPL-2.0 applies only to source code
owned by this project.

## Runtime and bundled components

| Component | License |
| --- | --- |
| Electron | MIT |
| electron-store | MIT |
| ExcelJS | MIT |
| iconv-lite | MIT |
| lucide-react | ISC |
| mssql | MIT |
| mysql2 | MIT |
| node-oracledb | Apache-2.0 OR UPL-1.0 |
| node-postgres (`pg`) | MIT |
| React and React DOM | MIT |
| React Flow | MIT |
| node-redis | MIT |
| asn1 | MIT |
| bcrypt-pbkdf | BSD-3-Clause |
| safer-buffer | MIT |
| ssh2 | MIT |
| tweetnacl | Unlicense |
| write-excel-file | MIT |
| xterm.js and xterm-addon-fit | MIT |

These packages may include transitive dependencies under additional
permissive licenses. Their package metadata and license files are retained in
the dependency distribution. Electron also carries the notices required by
Chromium, Node.js and other projects in its own distribution.

## Build-time components

The project uses Electron Builder, Electron Vite, Vite, ESLint and the React
plugin for Vite. These tools are used to build the application and are not
relicensed by this project.

## Dameng database driver

The vendor `dmdb` Node.js driver is not included in the public dependency lock
or public application package because its vendor license restricts
redistribution. The application can load an unmodified external `dmdb` package
from a folder explicitly selected by the user. It stores only that local path;
it does not copy the driver, add it to configuration exports, or redistribute
it. Users must obtain the driver lawfully, review and accept the vendor license,
and ensure that their use is permitted.

For explicitly enabled legacy-server compatibility, Ops Flow can start the
user-installed driver in a separate user-selected or auto-detected Node.js
runtime. The application enables the OpenSSL legacy provider only when that
runtime needs it. No Node.js runtime or vendor driver is copied into the
application by this feature. The runtime path,
compatibility preference and driver path remain local and are excluded from
configuration exports.

## No endorsement

Third-party project names and trademarks belong to their respective owners.
Their inclusion does not imply endorsement of Ops Flow Plus.
