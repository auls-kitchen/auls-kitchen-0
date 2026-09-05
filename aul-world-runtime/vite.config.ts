import { defineConfig } from "vite";

// AWR-01 isolated prototype. No connection to the production build,
// no connection to Firebase, no deployment target configured here.
export default defineConfig({
  root: __dirname,
  build: {
    outDir: "dist",
  },
});
