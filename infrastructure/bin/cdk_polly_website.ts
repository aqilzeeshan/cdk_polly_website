#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkPollyWebsiteStack } from '../lib/cdk_polly_website-stack';

const app = new cdk.App();
new CdkPollyWebsiteStack(app, 'CdkPollyWebsiteStack');
