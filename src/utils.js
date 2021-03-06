import path from 'path';
import urlUtils from 'url';

import sourceMap from 'source-map';
import parseDataURL from 'data-urls';

import { decode } from 'iconv-lite';

import { urlToRequest } from 'loader-utils';

import labelsToNames from './labels-to-names';

// Matches only the last occurrence of sourceMappingURL
const innerRegex = /\s*[#@]\s*sourceMappingURL\s*=\s*([^\s'"]*)\s*/;

/* eslint-disable prefer-template */
const sourceMappingURLRegex = RegExp(
  '(?:' +
    '/\\*' +
    '(?:\\s*\r?\n(?://)?)?' +
    '(?:' +
    innerRegex.source +
    ')' +
    '\\s*' +
    '\\*/' +
    '|' +
    '//(?:' +
    innerRegex.source +
    ')' +
    ')' +
    '\\s*'
);
/* eslint-enable prefer-template */

function labelToName(label) {
  const labelLowercase = String(label).trim().toLowerCase();

  return labelsToNames[labelLowercase] || null;
}

async function flattenSourceMap(map) {
  const consumer = await new sourceMap.SourceMapConsumer(map);
  const generatedMap = map.file
    ? new sourceMap.SourceMapGenerator({
        file: map.file,
      })
    : new sourceMap.SourceMapGenerator();

  consumer.sources.forEach((sourceFile) => {
    const sourceContent = consumer.sourceContentFor(sourceFile, true);
    generatedMap.setSourceContent(sourceFile, sourceContent);
  });

  consumer.eachMapping((mapping) => {
    const { source } = consumer.originalPositionFor({
      line: mapping.generatedLine,
      column: mapping.generatedColumn,
    });

    const mappings = {
      source,
      original: {
        line: mapping.originalLine,
        column: mapping.originalColumn,
      },
      generated: {
        line: mapping.generatedLine,
        column: mapping.generatedColumn,
      },
    };

    if (source) {
      generatedMap.addMapping(mappings);
    }
  });

  return generatedMap.toJSON();
}

function getSourceMappingURL(code) {
  const lines = code.split(/^/m);
  let match;

  for (let i = lines.length - 1; i >= 0; i--) {
    match = lines[i].match(sourceMappingURLRegex);
    if (match) {
      break;
    }
  }

  return {
    sourceMappingURL: match ? match[1] || match[2] || '' : null,
    replacementString: match ? match[0] : null,
  };
}

function getAbsolutePath(context, url, sourceRoot) {
  const request = urlToRequest(url, true);

  if (sourceRoot) {
    if (path.isAbsolute(sourceRoot)) {
      return path.join(sourceRoot, request);
    }

    return path.join(context, urlToRequest(sourceRoot, true), request);
  }

  return path.join(context, request);
}

function fetchFromDataURL(loaderContext, sourceURL) {
  const dataURL = parseDataURL(sourceURL);

  if (dataURL) {
    dataURL.encodingName =
      labelToName(dataURL.mimeType.parameters.get('charset')) || 'UTF-8';

    return decode(dataURL.body, dataURL.encodingName);
  }

  throw new Error(`Failed to parse source map from "data" URL: ${sourceURL}`);
}

async function fetchFromFilesystem(loaderContext, sourceURL) {
  let buffer;

  try {
    buffer = await new Promise((resolve, reject) => {
      loaderContext.fs.readFile(sourceURL, (error, data) => {
        if (error) {
          return reject(error);
        }

        return resolve(data);
      });
    });
  } catch (error) {
    throw new Error(
      `Failed to parse source map from '${sourceURL}' file: ${error}`
    );
  }

  return buffer.toString();
}

async function fetchFromURL(
  loaderContext,
  context,
  url,
  sourceRoot,
  skipReading = false
) {
  // 1. It's an absolute url and it is not `windows` path like `C:\dir\file`
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !path.win32.isAbsolute(url)) {
    const { protocol } = urlUtils.parse(url);

    if (protocol === 'data:') {
      const sourceContent = fetchFromDataURL(loaderContext, url);

      return { sourceContent };
    }

    if (protocol === 'file:') {
      const pathFromURL = urlUtils.fileURLToPath(url);

      const sourceURL = path.normalize(pathFromURL);

      let sourceContent;

      if (!skipReading) {
        sourceContent = await fetchFromFilesystem(loaderContext, sourceURL);
      }

      return { sourceURL, sourceContent };
    }

    throw new Error(
      `Failed to parse source map: "${url}" URL is not supported`
    );
  }

  // 2. It's a scheme-relative
  if (/^\/\//.test(url)) {
    throw new Error(
      `Failed to parse source map: "${url}" URL is not supported`
    );
  }

  // 3. Absolute path
  if (path.isAbsolute(url)) {
    const sourceURL = path.normalize(url);

    let sourceContent;

    if (!skipReading) {
      sourceContent = await fetchFromFilesystem(loaderContext, sourceURL);
    }

    return { sourceURL, sourceContent };
  }

  // 4. Relative path
  const sourceURL = getAbsolutePath(context, url, sourceRoot);

  let sourceContent;

  if (!skipReading) {
    sourceContent = await fetchFromFilesystem(loaderContext, sourceURL);
  }

  return { sourceURL, sourceContent };
}

export { getSourceMappingURL, fetchFromURL, flattenSourceMap };
