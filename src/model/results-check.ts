import * as core from '@actions/core';
import * as fs from 'fs';
import * as github from '@actions/github';
import Handlebars from 'handlebars';
import ResultsParser from './results-parser';
import { RunMeta } from './results-meta';
import path from 'path';

// The max size to for output api request
// the true limit is 65535 but leaving some buffer
const maxCheckOutputSize = 65000;

function isOutputToBig(output) {
  return (
    output.title.length + output.summary.length + output.text.length + output.annotations.length >=
    maxCheckOutputSize
  );
}

const ResultsCheck = {
  async createCheck(artifactsPath, githubToken, checkName) {
    // Validate input
    if (!fs.existsSync(artifactsPath) || !githubToken || !checkName) {
      throw new Error(
        `Missing input! {"artifactsPath": "${artifactsPath}",  "githubToken": "${githubToken}, "checkName": "${checkName}"`,
      );
    }

    // Parse all results files
    const runs: RunMeta[] = [];
    const files = fs.readdirSync(artifactsPath);
    await Promise.all(
      files.map(async filepath => {
        if (!filepath.endsWith('.xml')) return;
        core.info(`Processing file ${filepath}...`);
        const fileData = await ResultsParser.parseResults(path.join(artifactsPath, filepath));
        core.info(fileData.summary);
        runs.push(fileData);
      }),
    );

    // Combine all results into a single run summary
    const runSummary = new RunMeta(checkName);
    for (const run of runs) {
      runSummary.total += run.total;
      runSummary.passed += run.passed;
      runSummary.skipped += run.skipped;
      runSummary.failed += run.failed;
      runSummary.duration += run.duration;
      for (const suite of run.suites) {
        runSummary.addTests(suite.tests);
      }
    }

    // Log
    core.info('=================');
    core.info('Analyze result:');
    core.info(runSummary.summary);

    // Format output
    const title = runSummary.summary;
    const summary = await ResultsCheck.renderSummary(runs);
    core.debug(`Summary view: ${summary}`);
    const details = await ResultsCheck.renderDetails(runs, false);
    core.debug(`Details view: ${details}`);
    const rawAnnotations = runSummary.extractAnnotations();
    core.debug(`Raw annotations: ${rawAnnotations}`);
    const annotations = rawAnnotations.map(rawAnnotation => {
      const annotation = rawAnnotation;
      annotation.path = rawAnnotation.path.replace('/github/workspace/', '');
      return annotation;
    });
    core.debug(`Annotations: ${annotations}`);
    const output = {
      title,
      summary,
      text: details,
      annotations: annotations.slice(0, 50),
    };

    if (isOutputToBig(output)) {
      core.info('Output larger than check api limit trying to display only failures');
      output.text = await ResultsCheck.renderDetails(runs, true);
      if (isOutputToBig(output)) {
        core.info('Output larger than check api limit, truncating response');
        output.text = `Output truncated due to api size limit please open the log to see all the test results`;
      }
    }

    // Call GitHub API
    await ResultsCheck.requestGitHubCheck(githubToken, checkName, output);
    return runSummary.failed;
  },

  async requestGitHubCheck(githubToken, checkName, output) {
    const pullRequest = github.context.payload.pull_request;
    const headSha = (pullRequest && pullRequest.head.sha) || github.context.sha;

    core.info(`Posting results for ${headSha}`);
    const createCheckRequest = {
      ...github.context.repo,
      name: checkName,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'neutral',
      output,
    };

    const octokit = github.getOctokit(githubToken);
    await octokit.rest.checks.create(createCheckRequest);
  },

  async renderSummary(runMetas) {
    return ResultsCheck.render(`${__dirname}/../views/results-check-summary.hbs`, runMetas, false);
  },

  async renderDetails(runMetas, onlyRenderFailures) {
    return ResultsCheck.render(
      `${__dirname}/../views/results-check-details.hbs`,
      runMetas,
      onlyRenderFailures,
    );
  },

  async render(viewPath, runMetas, onlyRenderFailures) {
    Handlebars.registerHelper('indent', toIndent =>
      toIndent
        .split('\n')
        .map(s => `        ${s.replace('/github/workspace/', '')}`)
        .join('\n'),
    );
    Handlebars.registerHelper(
      'shouldRender',
      result => !onlyRenderFailures || result === 'Failed' || result > 0,
    );
    const source = await fs.promises.readFile(viewPath, 'utf8');
    const template = Handlebars.compile(source);
    return template(
      { runs: runMetas },
      {
        allowProtoMethodsByDefault: true,
        allowProtoPropertiesByDefault: true,
      },
    );
  },
};

export default ResultsCheck;
