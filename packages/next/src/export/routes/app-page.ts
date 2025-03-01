import type { ExportRouteResult, FileWriter } from '../types'
import type { RenderOpts } from '../../server/app-render/types'
import type { NextParsedUrlQuery } from '../../server/request-meta'
import type { RouteMetadata } from './types'

import type {
  MockedRequest,
  MockedResponse,
} from '../../server/lib/mock-request'
import {
  RSC_HEADER,
  NEXT_URL,
  NEXT_ROUTER_PREFETCH_HEADER,
} from '../../client/components/app-router-headers'
import { isDynamicUsageError } from '../helpers/is-dynamic-usage-error'
import {
  NEXT_CACHE_TAGS_HEADER,
  NEXT_META_SUFFIX,
  RSC_PREFETCH_SUFFIX,
  RSC_SUFFIX,
} from '../../lib/constants'
import { hasNextSupport } from '../../telemetry/ci-info'
import { lazyRenderAppPage } from '../../server/future/route-modules/app-page/module.render'

export const enum ExportedAppPageFiles {
  HTML = 'HTML',
  FLIGHT = 'FLIGHT',
  META = 'META',
  POSTPONED = 'POSTPONED',
}

async function generatePrefetchRsc(
  req: MockedRequest,
  path: string,
  res: MockedResponse,
  pathname: string,
  htmlFilepath: string,
  renderOpts: RenderOpts,
  fileWriter: FileWriter
): Promise<boolean> {
  // TODO: Re-enable once this is better supported client-side
  // It's currently not reliable to generate these prefetches because the client router
  // depends on the RSC payload being generated with FlightRouterState. When we generate these prefetches
  // without router state, it causes mismatches on client-side nav, resulting in subtle navigation bugs
  // like unnecessarily re-rendering layouts.
  return false

  // When we're in PPR, the RSC payload is emitted as the prefetch payload, so
  // attempting to generate a prefetch RSC is an error.
  if (renderOpts.experimental.ppr) {
    throw new Error(
      'Invariant: explicit prefetch RSC cannot be generated with PPR enabled'
    )
  }

  req.headers[RSC_HEADER.toLowerCase()] = '1'
  req.headers[NEXT_URL.toLowerCase()] = path
  req.headers[NEXT_ROUTER_PREFETCH_HEADER.toLowerCase()] = '1'

  renderOpts.supportsDynamicHTML = true
  renderOpts.isPrefetch = true
  delete renderOpts.isRevalidate

  const prefetchRenderResult = await lazyRenderAppPage(
    req,
    res,
    pathname,
    {},
    renderOpts
  )

  const prefetchRscData = await prefetchRenderResult.toUnchunkedString(true)

  if ((renderOpts as any).store.staticPrefetchBailout) return false

  await fileWriter(
    ExportedAppPageFiles.FLIGHT,
    htmlFilepath.replace(/\.html$/, RSC_PREFETCH_SUFFIX),
    prefetchRscData
  )

  return true
}

export async function exportAppPage(
  req: MockedRequest,
  res: MockedResponse,
  page: string,
  path: string,
  pathname: string,
  query: NextParsedUrlQuery,
  renderOpts: RenderOpts,
  htmlFilepath: string,
  debugOutput: boolean,
  isDynamicError: boolean,
  isAppPrefetch: boolean,
  fileWriter: FileWriter
): Promise<ExportRouteResult> {
  // If the page is `/_not-found`, then we should update the page to be `/404`.
  if (page === '/_not-found') {
    pathname = '/404'
  }

  try {
    if (isAppPrefetch) {
      const generated = await generatePrefetchRsc(
        req,
        path,
        res,
        pathname,
        htmlFilepath,
        renderOpts,
        fileWriter
      )

      if (generated) {
        return { revalidate: 0 }
      }
    }

    const result = await lazyRenderAppPage(
      req,
      res,
      pathname,
      query,
      renderOpts
    )

    const html = result.toUnchunkedString()

    const {
      metadata: { pageData, revalidate = false, postponed, fetchTags },
    } = result
    const { metadata } = result

    // Ensure we don't postpone without having PPR enabled.
    if (postponed && !renderOpts.experimental.ppr) {
      throw new Error('Invariant: page postponed without PPR being enabled')
    }

    if (revalidate === 0) {
      if (isDynamicError) {
        throw new Error(
          `Page with dynamic = "error" encountered dynamic data method on ${path}.`
        )
      }

      if (!(renderOpts as any).store.staticPrefetchBailout) {
        await generatePrefetchRsc(
          req,
          path,
          res,
          pathname,
          htmlFilepath,
          renderOpts,
          fileWriter
        )
      }

      const { staticBailoutInfo = {} } = metadata

      if (revalidate === 0 && debugOutput && staticBailoutInfo?.description) {
        logDynamicUsageWarning({
          path,
          description: staticBailoutInfo.description,
          stack: staticBailoutInfo.stack,
        })
      }

      return { revalidate: 0 }
    }
    // If PPR is enabled, we want to emit a prefetch rsc file for the page
    // instead of the standard rsc. This is because the standard rsc will
    // contain the dynamic data.
    else if (renderOpts.experimental.ppr) {
      // If PPR is enabled, we should emit the flight data as the prefetch
      // payload.
      await fileWriter(
        ExportedAppPageFiles.FLIGHT,
        htmlFilepath.replace(/\.html$/, RSC_PREFETCH_SUFFIX),
        pageData
      )
    } else {
      // Writing the RSC payload to a file if we don't have PPR enabled.
      await fileWriter(
        ExportedAppPageFiles.FLIGHT,
        htmlFilepath.replace(/\.html$/, RSC_SUFFIX),
        pageData
      )
    }

    const headers = { ...metadata.headers }

    if (fetchTags) {
      headers[NEXT_CACHE_TAGS_HEADER] = fetchTags
    }

    // Writing static HTML to a file.
    await fileWriter(
      ExportedAppPageFiles.HTML,
      htmlFilepath,
      html ?? '',
      'utf8'
    )

    // Writing the request metadata to a file.
    const meta: RouteMetadata = {
      status: undefined,
      headers,
      postponed,
    }

    await fileWriter(
      ExportedAppPageFiles.META,
      htmlFilepath.replace(/\.html$/, NEXT_META_SUFFIX),
      JSON.stringify(meta, null, 2)
    )

    return {
      // Only include the metadata if the environment has next support.
      metadata: hasNextSupport ? meta : undefined,
      hasEmptyPrelude: Boolean(postponed) && html === '',
      hasPostponed: Boolean(postponed),
      revalidate,
    }
  } catch (err: any) {
    if (!isDynamicUsageError(err)) {
      throw err
    }

    if (debugOutput) {
      const { dynamicUsageDescription, dynamicUsageStack } = (renderOpts as any)
        .store

      logDynamicUsageWarning({
        path,
        description: dynamicUsageDescription,
        stack: dynamicUsageStack,
      })
    }

    return { revalidate: 0 }
  }
}

function logDynamicUsageWarning({
  path,
  description,
  stack,
}: {
  path: string
  description: string
  stack?: string
}) {
  const errMessage = new Error(
    `Static generation failed due to dynamic usage on ${path}, reason: ${description}`
  )

  if (stack) {
    errMessage.stack = errMessage.message + stack.substring(stack.indexOf('\n'))
  }

  console.warn(errMessage)
}
