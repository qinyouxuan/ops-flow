# Third-party notices

Ops Flow Plus contains or depends on third-party software. Those components
remain governed by their own licenses; MPL-2.0 applies only to source code
owned by this project.

## Runtime and bundled components

| Component | License |
| --- | --- |
| Electron | MIT |
| electron-store | MIT |
| lucide-react | ISC |
| mssql | MIT |
| mysql2 | MIT |
| node-oracledb | Apache-2.0 OR UPL-1.0 |
| node-postgres (`pg`) | MIT |
| React and React DOM | MIT |
| React Flow | MIT |
| node-redis | MIT |
| ssh2 | MIT |
| SheetJS Community Edition (`xlsx`) | Apache-2.0 |
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
redistribution. The source retains an optional runtime integration point.
Anyone creating a DM-enabled build must obtain the driver from its vendor,
review and accept the vendor license, and ensure that their intended use and
distribution are permitted.

## No endorsement

Third-party project names and trademarks belong to their respective owners.
Their inclusion does not imply endorsement of Ops Flow Plus.
