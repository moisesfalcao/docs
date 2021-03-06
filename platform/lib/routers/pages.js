/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const express = require('express');
const config = require('../config');
const HttpProxy = require('http-proxy');
const modifyResponse = require('http-proxy-response-rewrite');
const { Signale } = require('signale');
const { FilteredPage } = require('../pipeline/filteredPage');
const got = require('got');

const pages = express.Router();
const growHost = `${config.hosts.pages.scheme}://${config.hosts.pages.host}:${config.hosts.pages.port}`;

/**
 * Inspects a incoming request (either proxied or not) for its GET args
 * and URL and checks if its valid to filter and if so has a valid filter
 * @param  {expressjs.Request} request
 * @return {null|String}       A valid filter
 */
function getFilteredFormat(request) {
  const QUERY_PARAMETER_NAME = 'format';
  const ALLOWED_FORMATS = ['websites', 'stories', 'ads', 'email'];
  const FILTERABLE_ROUTES = [];

  let activeFormat = request.query[QUERY_PARAMETER_NAME] || '';
  if (ALLOWED_FORMATS.indexOf(activeFormat.toLowerCase()) == -1) {
    // If the format that should be filtered by isn't valid go on
    return;
  }

  return activeFormat;
}

async function hasManualFormatVariant(request, format) {
  let path = request.originalUrl.replace('.html', `.${format}.html`);

  let page = await got(`${growHost}${path}`).catch(() => {
    return {};
  });

  if (!page.error && page.body) {
    return true;
  }

  return false;
}


// Setup a proxy over to Grow during development
if (config.environment === 'development') {
  // Also create a logger during development since you want to know
  // what's going on
  const log = new Signale({
    'interactive': true,
    'scope': 'Format filter'
  });

  // Grow has problems delivering the index.html on a root request
  pages.get('/', (request, response, next) => {
    response.redirect('/index.html');
    next();
  });

  // On production (Google App Engine) these files will be served
  // by what is defined inside app.yaml
  pages.use('/static/', express.static('static'));

  // During development all requests should be proxied over
  // to Grow and be handled there, therfore create one
  const proxy = new HttpProxy();

  // As the filtering will happen on content from the proxy (which will end
  // expressjs' native middleware chain) we need to hook into the proxy
  proxy.on('proxyRes', async function (proxyResponse, request, response) {
    // Check if this response should be filtered
    let activeFormat = getFilteredFormat(request);

    if (activeFormat) {
      log.await(`Filtering the ongoing request by format: ${activeFormat}`);

      modifyResponse(response, proxyResponse.headers['content-encoding'], (body) => {
          let filteredPage = new FilteredPage(activeFormat, body);
          return filteredPage.content;
      });
    }
  });

  pages.get('/*', async (request, response, next) => {
    // Check if there is a manually filtered variant of the requested page
    // and if so rewrite the request to this URL
    let activeFormat = getFilteredFormat(request);
    if (activeFormat) {
      log.info('Checking for manual variant of requested page ...');
      if (await hasManualFormatVariant(request, activeFormat)) {
        let url = request.url.replace('.html', `.${activeFormat}.html`);
        log.success(`Manually filtered variant exists - rewriting request to ${url}`);
        request.url = url;
      }
    }

    next();
  }, (request, response, next) => {
    proxy.web(request, response, {
      'target': growHost
    }, next);
  });
}

if (config.environment !== 'development') {
  pages.use('/', (request, response, next) => {
    // Check if this request should be filtered
    let activeFormat = getFilteredFormat(request);
    if (activeFormat) {
      // And if it should be filtered rewrite to the correct file
      request.url = request.url.replace('.html', `.${activeFormat}.html`);
    }

    next();
  }, express.static('pages'));
}

module.exports = pages;
