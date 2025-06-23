// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CompressionAlgorithm, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { gzipSync } from 'zlib';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { AwsAuthenticator } from './aws-authenticator';
import { PassthroughSerializer } from './passthrough-serializer';
import { ISerializer } from '@opentelemetry/otlp-transformer';
import { diag } from '@opentelemetry/api';

/**
 * Base class for AWS OTLP exporters
 */
export abstract class OTLPAwsBaseExporter<Payload, Response> {
  protected parentExporter: OTLPExporterBase<Payload>;
  private readonly originalHeaders: Readonly<Record<string, string>>;
  private newHeaders: Record<string, string>;
  private compression?: CompressionAlgorithm;
  private endpoint: string;
  private serializer: PassthroughSerializer<Response>;
  private authenticator: AwsAuthenticator;
  private parentSerializer: ISerializer<Payload, Response>;

  constructor(
    endpoint: string,
    service: string,
    parentExporter: OTLPExporterBase<Payload>,
    parentSerializer: ISerializer<Payload, Response>,
    compression?: CompressionAlgorithm
  ) {
    this.compression = compression;
    this.endpoint = endpoint;
    this.authenticator = new AwsAuthenticator(this.endpoint, service);
    this.parentExporter = parentExporter;
    this.parentSerializer = parentSerializer;

    // To prevent performance degradation from serializing and compressing data twice, we handle serialization and compression
    // locally in this exporter and pass the pre-processed data to the upstream export.
    // This is used in order to prevent serializing and compressing the data again when calling parentExporter.export().
    // To see why this works:
    // https://github.com/open-telemetry/opentelemetry-js/blob/ec17ce48d0e5a99a122da5add612a20e2dd84ed5/experimental/packages/otlp-exporter-base/src/otlp-export-delegate.ts#L69
    this.serializer = new PassthroughSerializer<Response>(this.parentSerializer.deserializeResponse);
    this.parentExporter['_delegate']._serializer = this.serializer;

    this.originalHeaders = OTLPAwsBaseExporter.deepCopy(
      this.parentExporter['_delegate']._transport?._transport?._parameters?.headers()
    );
    this.newHeaders = {};
  }

  /**
   * Overrides the upstream implementation of export.
   * All behaviors are the same except if the endpoint is an AWS OTLP endpoint, we will sign the request with SigV4
   * in headers before sending it to the endpoint.
   * @param items - Array of signal data to export
   * @param resultCallback - Callback function to handle export result
   */
  public async export(items: Payload, resultCallback: (result: ExportResult) => void): Promise<void> {
    if (this.originalHeaders) {
      let serializedData: Uint8Array | undefined = this.parentSerializer.serializeRequest(items);

      if (!serializedData) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error('Nothing to send'),
        });
        return;
      }

      const shouldCompress = this.compression && this.compression !== CompressionAlgorithm.NONE;

      if (shouldCompress) {
        try {
          serializedData = gzipSync(serializedData);
          this.addHeader('Content-Encoding', 'gzip');
        } catch (exception) {
          resultCallback({
            code: ExportResultCode.FAILED,
            error: new Error(`Failed to compress: ${exception}`),
          });
          return;
        }
      }

      this.serializer.setSerializedData(serializedData);

      const headers: Record<string, string> = { ...this.originalHeaders, ...this.newHeaders };

      const signedRequestHeaders: Record<string, string> = await this.authenticator.authenticate(
        headers,
        serializedData
      );

      if ('authorization' in signedRequestHeaders) {
        this.parentExporter['_delegate']._transport._transport._parameters.headers = () => signedRequestHeaders;
      }

      this.parentExporter.export(items, resultCallback);
      this.cleanupHeaders();
    } else {
      diag.debug('OTLP Exporter transport headers are undefined. Not exporting.');
    }
  }

  /**
   * Adds a header to the exporter's transport parameters
   * @param key - Header key
   * @param value - Header value
   */
  protected addHeader(key: string, value: string): void {
    // Do not override upstream's headers
    if (!(key in this.originalHeaders)) {
      this.newHeaders[key] = value;
    }
  }

  /**
   * Restores headers to their original state before any modifications
   */
  private cleanupHeaders(): void {
    this.parentExporter['_delegate']._transport._transport._parameters.headers = () =>
      OTLPAwsBaseExporter.deepCopy(this.originalHeaders);

    this.newHeaders = {};
  }

  /**
   * Creates a deep copy of the given object.
   */
  private static deepCopy(obj: Record<string, any> | undefined): Record<string, any> {
    return obj ? JSON.parse(JSON.stringify(obj)) : {};
  }
}
