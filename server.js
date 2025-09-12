==> Downloading cache...
==> Cloning from https://github.com/kooldude62/EPICKALL
==> Checking out commit 950847cd0746141a2465726e824c6974bf1ce953 in branch main
==> Transferred 55MB in 8s. Extraction took 1s.
==> Using Node.js version 22.16.0 (default)
==> Docs on specifying a Node.js version: https://render.com/docs/node-version
==> Running build command 'yarn install'...
yarn install v1.22.22
info No lockfile found.
[1/4] Resolving packages...
warning multer@1.4.5-lts.2: Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x. You should upgrade to the latest 2.x version.
[2/4] Fetching packages...
[3/4] Linking dependencies...
[4/4] Building fresh packages...
success Saved lockfile.
Done in 2.80s.
==> Uploading build...
==> Uploaded in 3.5s. Compression took 1.1s
==> Build successful 🎉
==> Deploying...
==> Running 'yarn start'
yarn run v1.22.22
$ node server.js
file:///opt/render/project/src/server.js:14
app.use(express.static(path.join(__dirname, "public")));
                                 ^
ReferenceError: __dirname is not defined in ES module scope
This file is being treated as an ES module because it has a '.js' file extension and '/opt/render/project/src/package.json' contains "type": "module". To treat it as a CommonJS script, rename it to use the '.cjs' file extension.
    at file:///opt/render/project/src/server.js:14:34
    at ModuleJob.run (node:internal/modules/esm/module_job:274:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:644:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)
Node.js v22.16.0
error Command failed with exit code 1.
info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.
==> Exited with status 1
==> Common ways to troubleshoot your deploy: https://render.com/docs/troubleshooting-deploys
==> Running 'yarn start'
yarn run v1.22.22
