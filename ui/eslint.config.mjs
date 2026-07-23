// Next.js 16 removed the built-in `next lint` command, so linting now runs the
// ESLint CLI directly against this flat config. `eslint-config-next` ships a
// native flat-config array (core-web-vitals bundles next/react/typescript).
import next from 'eslint-config-next/core-web-vitals'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  { ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'] },
  ...next,
]

export default config
