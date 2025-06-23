// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPLogExporter as OTLPProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { IExportLogsServiceResponse, ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer';
import { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { OTLPAwsBaseExporter } from '../common/otlp-aws-base-exporter';
import { assert } from 'console';

/**
 * Below is the protobuf-JSON formatted path to "content" and "role" for the
 * following GenAI Consolidated Log Event Schema:
 * "body": {
 *     "output": {
 *         "messages": [
 *             {
 *                 "content": "hi",
 *                 "role": "assistant"
 *             }
 *         ]
 *     },
 *     "input": {
 *         "messages": [
 *             {
 *                 "content": "hello",
 *                 "role": "user"
 *             }
 *         ]
 *     }
 * }
 */
export const LARGE_GEN_AI_LOG_PATH_HEADER: string =
  "\\$['resourceLogs'][0]['scopeLogs'][0]['logRecords'][0]['body']" + // body
  "['kvlistValue']['values'][*]['value']" + // body['output'], body['input']
  "['kvlistValue']['values'][0]['value']" + // body['output']['messages'], body['input']['messages']
  "['arrayValue']['values'][*]" + // body['output']['messages'][0..999], body['input']['messages'][0..999]
  "['kvlistValue']['values'][*]['value']['stringValue']"; // body['output']['messages'][0..999]['content'/'role']

export const LARGE_LOG_HEADER: string = 'x-aws-truncatable-fields';

/**
 * This exporter extends the functionality of the OTLPProtoLogExporter to allow logs to be exported
 * to the CloudWatch Logs OTLP endpoint https://logs.[AWSRegion].amazonaws.com/v1/logs. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 * @param endpoint - The AWS CloudWatch Logs OTLP endpoint URL
 * @param config - Optional OTLP exporter configuration
 */
export class OTLPAwsLogExporter
  extends OTLPAwsBaseExporter<ReadableLogRecord[], IExportLogsServiceResponse>
  implements LogRecordExporter
{
  private genAILogFlag: boolean;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    const parentExporter = new OTLPProtoLogExporter(modifiedConfig);
    super(endpoint, 'logs', parentExporter, ProtobufLogsSerializer, config?.compression);

    this.genAILogFlag = false;
    assert(this.genAILogFlag, false);
  }

  public override async export(items: ReadableLogRecord[], resultCallback: (result: any) => void): Promise<void> {
    if (this.genAILogFlag) {
      this.addHeader(LARGE_LOG_HEADER, LARGE_GEN_AI_LOG_PATH_HEADER);
    }

    await super.export(items, resultCallback);
  }

  /**
   * Sets a flag that indicates the current log batch contains
   * a generative AI log record that exceeds the CloudWatch Logs size limit (1MB).
   */
  public setGenAILogFlag(): void {
    this.genAILogFlag = true;
  }

  shutdown(): Promise<void> {
    return this.parentExporter.shutdown();
  }
}
