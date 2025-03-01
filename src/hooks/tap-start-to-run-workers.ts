import type * as webpack from 'webpack';

import type { FilesChange } from '../files-change';
import { consumeFilesChange } from '../files-change';
import { getInfrastructureLogger } from '../infrastructure-logger';
import type { ForkTsCheckerWebpackPluginConfig } from '../plugin-config';
import { getPluginHooks } from '../plugin-hooks';
import { dependenciesPool, issuesPool } from '../plugin-pools';
import type { ForkTsCheckerWebpackPluginState } from '../plugin-state';
import type { RpcWorker } from '../rpc';
import type { GetDependenciesWorker } from '../typescript/worker/get-dependencies-worker';
import type { GetIssuesWorker } from '../typescript/worker/get-issues-worker';

import { interceptDoneToGetDevServerTap } from './intercept-done-to-get-dev-server-tap';
import { tapAfterCompileToGetIssues } from './tap-after-compile-to-get-issues';
import { tapDoneToAsyncGetIssues } from './tap-done-to-async-get-issues';

function tapStartToRunWorkers(
  compiler: webpack.Compiler,
  getIssuesWorker: RpcWorker<GetIssuesWorker>,
  getDependenciesWorker: RpcWorker<GetDependenciesWorker>,
  config: ForkTsCheckerWebpackPluginConfig,
  state: ForkTsCheckerWebpackPluginState
) {
  const hooks = getPluginHooks(compiler);
  const { log, debug } = getInfrastructureLogger(compiler);

  compiler.hooks.run.tap('ForkTsCheckerWebpackPlugin', () => {
    if (!state.initialized) {
      debug('Initializing plugin for single run (not async).');
      state.initialized = true;

      state.watching = false;
      tapAfterCompileToGetIssues(compiler, config, state);
    }
  });

  compiler.hooks.watchRun.tap('ForkTsCheckerWebpackPlugin', async () => {
    if (!state.initialized) {
      state.initialized = true;

      state.watching = true;
      if (config.async) {
        debug('Initializing plugin for watch run (async).');

        tapDoneToAsyncGetIssues(compiler, config, state);
        interceptDoneToGetDevServerTap(compiler, config, state);
      } else {
        debug('Initializing plugin for watch run (not async).');

        tapAfterCompileToGetIssues(compiler, config, state);
      }
    }
  });

  compiler.hooks.compilation.tap('ForkTsCheckerWebpackPlugin', async (compilation) => {
    if (compilation.compiler !== compiler) {
      // run only for the compiler that the plugin was registered for
      return;
    }

    const iteration = ++state.iteration;

    let change: FilesChange = {};

    if (state.watching) {
      change = consumeFilesChange(compiler);
      log(
        [
          'Calling reporter service for incremental check.',
          `  Changed files: ${JSON.stringify(change.changedFiles)}`,
          `  Deleted files: ${JSON.stringify(change.deletedFiles)}`,
        ].join('\n')
      );
    } else {
      log('Calling reporter service for single check.');
    }

    change = await hooks.start.promise(change, compilation);

    debug(`Submitting the getIssuesWorker to the pool, iteration ${iteration}.`);
    state.issuesPromise = issuesPool.submit(async () => {
      try {
        debug(`Running the getIssuesWorker, iteration ${iteration}.`);
        return await getIssuesWorker(change, state.watching);
      } catch (error) {
        hooks.error.call(error, compilation);
        return undefined;
      } finally {
        debug(`The getIssuesWorker finished its job, iteration ${iteration}.`);
      }
    });
    debug(`Submitting the getDependenciesWorker to the pool, iteration ${iteration}.`);
    state.dependenciesPromise = dependenciesPool.submit(async () => {
      try {
        debug(`Running the getDependenciesWorker, iteration ${iteration}.`);
        return await getDependenciesWorker(change);
      } catch (error) {
        hooks.error.call(error, compilation);
        return undefined;
      } finally {
        debug(`The getDependenciesWorker finished its job, iteration ${iteration}.`);
      }
    });
  });
}

export { tapStartToRunWorkers };
