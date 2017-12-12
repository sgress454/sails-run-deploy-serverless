# `sails-run-deploy-serverless`

A [Sails](https://sailsjs.com) command to deploy [actions](https://next.sailsjs.com/documentation/concepts/actions-and-controllers#?actions-2) as [AWS Lambda](https://aws.amazon.com/lambda/) functions via the [Serverless toolkit](https://serverless.com/).

### Usage

First, install Serverless:

```
npm install -g serverless
```

and follow the [instructions for setting your AWS credentials](https://serverless.com/framework/docs/providers/aws/guide/credentials/).

Then, install this command in your Sails app:

```
npm install sails-run-deploy-serverless
```

and invoke using `sails run deploy-serverless <options>`.

##### Options

The available options (you must choose one and only one) are:

* `--all`:  deploy (or redeploy) all functions.  You may need to do this when first adding a new endoint, or modifying the URL of an existing one.
* `--f <function name>`:  deploy only the function with the specified name.  Function names are the camel-cased version of the action name in Sails; for example, the action in `api/controllers/user/get.js` corresponds to a function named `userGet`.
* `--nodeploy`:  just generate the `serverless` folder, but don't actually deploy.  You can then go into the folder and deploy yourself with the Serverless CLI.

Note that every time you run the command, the local `serverless` folder is recreated.

### Datastores

_TODO: document `serverless-dev` and `serverless-prod`_

### Authorizers

_TODO: document route authorization_

### CORS

_TODO: document CORS_

### Configuration

##### `config/serverless.js`

This file allows you to declare which parts of your Sails app should be copied into the package that is deployed to AWS.  Available settings are:

* `include`: An array of file or folder paths (relative to the project root) to copy into the deployment package.  Defaults to `['api/controllers', 'api/helpers', 'api/models', 'config/models.js', 'config/datastores.js']`.

* `transpile`: An array of file or folder paths (relative to the project root) to transpile to ES5 before deploying.  At this time, Lambda only supports Node 6.  Defaults to `['api/controllers', 'api/helpers', 'api/models']`.

* `defaultAuthorizer`: The name of an authorizer function to use as the default for any route that doesn't explicitly set an `authorizer` option.  If left unset, routes will not be authorized by default.

* `orm`: Set to `false` if you don't want the deployed Lambda functions to use the Waterline ORM.

##### `config/serverless.yml`

This command creates a `serverless.yml` file with some sane defaults.  If you create a `config/serverless.yml` file in your app, it will be used as the basis for the YML file that the `deploy-serverless` command creates.  This is useful for setting up environment variables, VPCs, AWS Gateway Responses, etc.

### Links

##### Serverless
+ [Serverless AWS documentation](https://serverless.com/framework/docs/providers/aws/)
+ [Example `serverless.yml`](https://serverless.com/framework/docs/providers/aws/guide/serverless.yml/)


##### Sails
+ [Sails framework documentation](https://sailsjs.com/documentation)
+ [Version notes / upgrading](https://sailsjs.com/documentation/upgrading)
+ [Deployment tips](https://sailsjs.com/documentation/concepts/deployment)
+ [Community support options](https://sailsjs.com/support)
+ [Professional / enterprise options](https://sailsjs.com/studio)
