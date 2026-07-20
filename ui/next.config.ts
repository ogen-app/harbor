import type { NextConfig } from 'next'

// Harbor ships as a single Go binary: `make ui` runs `next build` with
// NEXT_OUTPUT=export to emit a static export into `out/`, which is copied to
// `src/ui/dist` and embedded by the Fiber server (see src/ui/embed.go).
//
//   - export mode: `output: 'export'` + unoptimized images (the Go server has
//     no Next image optimizer). Rewrites are unsupported by static export, so
//     they are only registered in dev.
//   - dev mode (`next dev`): the API is a separate process on :9002, so /api/*
//     is proxied there and everything is same-origin from the browser's view.
const isExport = process.env.NEXT_OUTPUT === 'export'
const apiURL = process.env.HARBOR_API_URL ?? 'http://localhost:9002'

const nextConfig: NextConfig = {
  images: {
    // Static export cannot use the Next image optimizer.
    unoptimized: isExport,
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840, 5120, 7680],
    qualities: [100, 75],
  },
  devIndicators: {
    position: 'bottom-right',
  },
  ...(isExport
    ? { output: 'export' }
    : {
        async rewrites() {
          return [
            {
              source: '/api/:path*',
              destination: `${apiURL}/api/:path*`,
            },
          ]
        },
      }),
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },
  webpack(config) {
    // Handle SVG imports as React components
    const fileLoaderRule = config.module.rules.find((rule: { test?: RegExp }) =>
      rule.test?.test?.('.svg')
    )
    if (fileLoaderRule) {
      fileLoaderRule.exclude = /\.svg$/
    }

    config.module.rules.push({
      test: /\.svg$/,
      use: ['@svgr/webpack'],
    })

    return config
  },
}

export default nextConfig
