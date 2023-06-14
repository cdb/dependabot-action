import axios from 'axios'
import axiosRetry from 'axios-retry'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {Context} from '@actions/github/lib/context'
import {ApiClient, CredentialFetchingError} from './api-client'
import {getJobParameters} from './inputs'
import {ImageService} from './image-service'
import {updaterImageName, PROXY_IMAGE_NAME} from './docker-tags'
import {Updater} from './updater'

export enum DependabotErrorType {
  Unknown = 'actions_workflow_unknown',
  Image = 'actions_workflow_image',
  UpdateRun = 'actions_workflow_updater'
}

let jobId: number

export async function run(context: Context): Promise<void> {
  try {
    botSay('starting update')

    // Retrieve JobParameters from the Actions environment
    const params = getJobParameters(context)
    botSay(`got params${JSON.stringify(params)}`)
    // The parameters will be null if the Action environment
    // is not a valid Dependabot-triggered dynamic event.
    if (params === null) {
      botSay('finished: nothing to do')
      return // TODO: This should be setNeutral in future
    }

    jobId = params.jobId
    botSay(`got job id${jobId}`)
    core.setSecret(params.jobToken)
    botSay('set job token')
    core.setSecret(params.credentialsToken)
    botSay('set credentials token')

    const client = axios.create({baseURL: params.dependabotApiUrl})
    botSay(`created axios client${JSON.stringify(client)}`)
    axiosRetry(client, {
      retryDelay: axiosRetry.exponentialDelay, // eslint-disable-line @typescript-eslint/unbound-method
      retryCondition: e => {
        return axiosRetry.isNetworkError(e) || axiosRetry.isRetryableError(e)
      }
    })
    botSay('set retry policy')
    const apiClient = new ApiClient(client, params)
    botSay(`created api client${JSON.stringify(apiClient)}`)
    core.info('Fetching job details')

    // If we fail to succeed in fetching the job details, we cannot be sure the job has entered a 'processing' state,
    // so we do not try attempt to report back an exception if this fails and instead rely on the workflow run
    // webhook as it anticipates scenarios where jobs have failed while 'enqueued'.
    const details = await apiClient.getJobDetails()

    // The dynamic workflow can specify which updater image to use. If it doesn't, fall back to the pinned version.
    const updaterImage =
      params.updaterImage || updaterImageName(details['package-manager'])

    try {
      const credentials = await apiClient.getCredentials()
      const updater = new Updater(
        updaterImage,
        PROXY_IMAGE_NAME,
        apiClient,
        details,
        credentials,
        params.workingDirectory
      )

      core.startGroup('Pulling updater images')
      try {
        await ImageService.pull(updaterImage)
        await ImageService.pull(PROXY_IMAGE_NAME)
      } catch (error: unknown) {
        if (error instanceof Error) {
          await failJob(
            apiClient,
            'Error fetching updater images',
            error,
            DependabotErrorType.Image
          )
          return
        }
      }
      core.endGroup()

      try {
        core.info('Starting update process')

        await updater.runUpdater()
      } catch (error: unknown) {
        if (error instanceof Error) {
          await failJob(
            apiClient,
            'Dependabot encountered an error performing the update',
            error,
            DependabotErrorType.UpdateRun
          )
          return
        }
      }
      botSay('finished')
    } catch (error: unknown) {
      if (error instanceof CredentialFetchingError) {
        await failJob(
          apiClient,
          'Dependabot was unable to retrieve job credentials',
          error,
          DependabotErrorType.UpdateRun
        )
      } else if (error instanceof Error) {
        await failJob(
          apiClient,
          'Dependabot was unable to start the update',
          error
        )
      }

      return
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      // If we've reached this point, we do not have a viable
      // API client to report back to Dependabot API.
      //
      // We output the raw error in the Action logs and defer
      // to workflow_run monitoring to detect the job failure.
      setFailed('Dependabot encountered an unexpected problem', error)
      botSay(`finished: unexpected error: ${JSON.stringify(error)}`)
    }
  }
}

async function failJob(
  apiClient: ApiClient,
  message: string,
  error: Error,
  errorType = DependabotErrorType.Unknown
): Promise<void> {
  await apiClient.reportJobError({
    'error-type': errorType,
    'error-details': {
      'action-error': error.message
    }
  })
  await apiClient.markJobAsProcessed()
  setFailed(message, error)
  botSay('finished: error reported to Dependabot')
}

function botSay(message: string): void {
  core.info(`🤖 ~ ${message} ~`)
}

function setFailed(message: string, error: Error | null): void {
  if (jobId) {
    message = [message, error, dependabotJobHelp()].filter(Boolean).join('\n\n')
  } else {
    message = [message, error].filter(Boolean).join('\n\n')
  }

  core.setFailed(message)
}

function dependabotJobHelp(): string | null {
  if (jobId) {
    return `For more information see: ${dependabotJobUrl(
      jobId
    )} (write access required)`
  } else {
    return null
  }
}

function dependabotJobUrl(id: number): string {
  const url_parts = [
    process.env.GITHUB_SERVER_URL,
    process.env.GITHUB_REPOSITORY,
    'network/updates',
    id
  ]

  return url_parts.filter(Boolean).join('/')
}

run(github.context)
