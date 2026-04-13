### Clone only the "hw#" snapshot (tag/branch) to ensure you get the exact Homework 2 version
git clone --branch hw# --single-branch https://github.com/YuanWa1/656tmp.git

### Enter the project directory
cd 656tmp

### Install project dependencies (requires Node.js + npm)
### If your repo includes package-lock.json, you can use `npm ci` for more reproducible installs
npm install

### Build the production bundle into the /dist folder
npm run build

### Serve the built /dist locally (most reliable way to run a Vite build)
### Open the URL printed in the terminal (commonly http://localhost:4173)
npm run preview