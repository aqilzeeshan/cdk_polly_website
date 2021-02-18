import * as cdk from '@aws-cdk/core';
import dynamodb = require('@aws-cdk/aws-dynamodb');
import lambda = require('@aws-cdk/aws-lambda');
import s3 = require('@aws-cdk/aws-s3');
import sns = require('@aws-cdk/aws-sns');
import iam = require('@aws-cdk/aws-iam');
import event_sources = require('@aws-cdk/aws-lambda-event-sources');
import apigw = require('@aws-cdk/aws-apigateway');
import s3Deployment = require('@aws-cdk/aws-s3-deployment');

//import apigw = require('@aws-cdk/aws-apigatewayv2');
//import integrations = require('@aws-cdk/aws-apigatewayv2-integrations');

export class CdkPollyWebsiteStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =====================================================================================
    // Amazon DynamoDB table for storing information about posts
    //Our primary key (id) is a string, which the “New Post” Lambda function creates when new records (posts) are inserted into a database.
    //The columns provide the following information:
    //* id – The ID of the post
    //* status – UPDATED or PROCESSING, depending on whether an MP3 file has already been created
    //* text – The post’s text, for which an audio file is being created
    //* url – A link to an S3 bucket where an audio file is being stored
    //* voice – The Amazon Polly voice that was used to create audio file
    // =====================================================================================
    const table = new dynamodb.Table(this, 'posts', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    new cdk.CfnOutput(this, 'ddbTable', { value: table.tableName });
    
    // =====================================================================================
    //Public Bucket to store all audio files and website created by the application
    // =====================================================================================
    const audioBucket = new s3.Bucket(this, "audioposts-931", {
      publicReadAccess: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      websiteIndexDocument: 'index.html',
    });
    new cdk.CfnOutput(this, 'resizedBucket', {value: audioBucket.bucketName});


    const deployment = new s3Deployment.BucketDeployment(
      this,
      'deployStaticWebsite',
      {
        sources: [s3Deployment.Source.asset('../client')],
        destinationBucket: audioBucket,
      }
    );

    // =====================================================================================
    //SNS topic decouple the application by allowing application to use asynchoronous calls
    //so that the user who sends a new post to the application receives the ID of the new DynamoDB item; 
    //so it knows what to ask for later; and to eliminate waiting for the conversion to finish.
    //It sends message about the new post from the first function to the second one.
    // =====================================================================================
    const topic = new sns.Topic(this, `new_posts`, {
      displayName: 'New posts'
    });

    // =====================================================================================
    //This role specifies which AWS services (APIs) the functions can interact with.
    //Customer Managed Policy to reuse with both Lambda functions
    //https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_managed-vs-inline.html
    // =====================================================================================
    const role = new iam.Role(this, 'LambdaPostsReaderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
   
    const policy = new iam.ManagedPolicy(this, "MyServerlessAppPolicy", {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "polly:SynthesizeSpeech",
            "s3:GetBucketLocation",
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ],
          resources: ["*"]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem"
          ],
          resources: ["*"]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:PutObject",
            "s3:PutObjectAcl",
            "s3:GetBucketLocation"
          ],
          resources: ["*"]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sns:Publish"
          ],
          resources: ["*"]
        })
      ]
    });
   
    // Creates a managed policy and then attaches the policy to role
    policy.attachToRole(role);

    // =====================================================================================
    //Lambda function does the following:
    //  1. Retrieves two input parameters (Voice and Text)
    //  2. Creates a new record in the DynamoDB table with information about the new post
    //  3. Publishes information about the new post to SNS (the ID of the DynamoDB item/post ID is published there as a message)
    //  4. Returns the ID of the DynamoDB item to the user
    // =====================================================================================
    const postReader_NewPost = new lambda.Function(this, 'PostReader_NewPost', {
      code: lambda.Code.fromAsset('lambda'),
      runtime: lambda.Runtime.PYTHON_2_7,
      handler: 'PostReader_NewPost.handler',
      timeout: cdk.Duration.seconds(300),
      environment: {
        "DB_TABLE_NAME": table.tableName,
        "SNS_TOPIC": topic.topicArn
      },
      role:role,
    });
  
    // =====================================================================================
    //Lambda function does the following:
    //  1.Retrieves the ID of the DynamoDB item (post ID) which should be converted into an audio file from the input message (SNS event)
    //  2.Retrieves the item from DynamoDB
    //  3.Converts the text into an audio stream
    //  4.Places the audio (MP3) file into an S3 bucket
    //  5.Updates the DynamoDB table with a reference to the S3 bucket and the new status
    // =====================================================================================
    const postReader_ConvertToAudio = new lambda.Function(this, 'PostReader_ConvertToAudio', {
      code: lambda.Code.fromAsset('lambda'),
      runtime: lambda.Runtime.PYTHON_2_7,
      handler: 'PostReader_ConvertToAudio.handler',
      timeout: cdk.Duration.seconds(300),
      environment: {
        "DB_TABLE_NAME": table.tableName,
        "BUCKET_NAME": audioBucket.bucketName
      },
      role:role
    });
    postReader_ConvertToAudio.addEventSource(new event_sources.SnsEventSource(topic));

    // =====================================================================================
    //Lambda function does the following:
    //  provides a method for retrieving information about posts from our database
    // =====================================================================================
    const postReader_GetPost = new lambda.Function(this, 'PostReader_GetPost', {
      code: lambda.Code.fromAsset('lambda'),
      runtime: lambda.Runtime.PYTHON_2_7,
      handler: 'PostReader_GetPost.handler',
      environment: {
        "DB_TABLE_NAME": table.tableName
      },
      role:role
    });

    // =====================================================================================
    //  PostReaderAPI expose our application logic as a RESTful web service so 
    //  it can be invoked easily using a standard HTTP protocol.
    //  CORS (cross-origin resource sharing) enables invoking the API from a website with a different hostname.
    // =====================================================================================
    const api = new apigw.RestApi(this, 'PostReaderAPI',{
      description:"API for PostReader Application ",
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS // this is also the default
      }
    });
    const getPostIntegration = new apigw.LambdaIntegration(postReader_GetPost,{
      proxy:false,
      requestParameters: {
        'integration.request.querystring.postId': 'method.request.querystring.postId',
      },
      requestTemplates: {
        'application/json': JSON.stringify({postId: "$input.params('postId')"})
      },
      passthroughBehavior: apigw.PassthroughBehavior.WHEN_NO_TEMPLATES,
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            // We can map response parameters
            // - Destination parameters (the key) are the response parameters (used in mappings)
            // - Source parameters (the value) are the integration response parameters or expressions
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        },
        {
          // For errors, we check if the error message is not empty, get the error data
          selectionPattern: "(\n|.)+",
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        }
      ],
    });

    api.root.addMethod('GET',getPostIntegration, {
      requestParameters: {
        'method.request.querystring.postId': true
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });

    const newPostIntegration = new apigw.LambdaIntegration(postReader_NewPost,{
      proxy:false,
      integrationResponses: [
        {
          statusCode: "200",
          responseParameters: {
            // We can map response parameters
            // - Destination parameters (the key) are the response parameters (used in mappings)
            // - Source parameters (the value) are the integration response parameters or expressions
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        },
        {
          // For errors, we check if the error message is not empty, get the error data
          selectionPattern: "(\n|.)+",
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': "'*'"
          }
        }
      ],
    });
    api.root.addMethod('POST',newPostIntegration,{
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });

    new cdk.CfnOutput(this, 'Url', { value: api.url });

    /*
    // defines an API Gateway Http API resource
    const postReaderHttpApi = new apigw.HttpApi(this, 'PostReaderAPI', {
      apiName: 'PostReaderAPI',
      corsPreflight: {
        allowHeaders: ['*'],
        allowMethods: [apigw.HttpMethod.GET, apigw.HttpMethod.HEAD, apigw.HttpMethod.OPTIONS, apigw.HttpMethod.POST],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(10),
      }
    });

    postReaderHttpApi.addRoutes({
      integration: new integrations.LambdaProxyIntegration({
        handler: postReader_NewPost
      }),
      methods: [apigw.HttpMethod.POST],
      path: '/post',
    });
    
    postReaderHttpApi.addRoutes({
      integration: new integrations.LambdaProxyIntegration({
        handler: postReader_GetPost
      }),
      methods: [apigw.HttpMethod.GET],
      path: '/posts',
    });

    new cdk.CfnOutput(this, 'HTTP API Url', {
      value: postReaderHttpApi.url ?? 'Something went wrong with the deploy'
    });
    */
  }
}
