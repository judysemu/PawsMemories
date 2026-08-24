/**
 * Root entry shim.
 *
 * Hostinger's Node deploy form requires an entry file, while its Express preset
 * ignores that field and runs `npm start` instead -- so a build either fails
 * validation with the field empty, or fails at deploy pointing at a file that
 * does not exist. This satisfies both paths: the panel gets a real server.js,
 * and it starts exactly what `npm start` would.
 *
 * The compiled entry is dist/index.js, which only exists after `npm run build`.
 * Keep this file free of logic -- it is a pointer, not a second entry point.
 */
import "./dist/index.js";
