const _ = require('@sailshq/lodash');
const mergeDictionaries = require('merge-dictionaries');

module.exports = {


  friendlyName: 'Deploy serverless',


  description: 'Deploy an app to a serverless service.',


  inputs: {

    all: {
      type: 'boolean',
      defaultsTo: false
    },

    c: {
      type: 'string'
    },

    f: {
      type: 'string'
    },

    j: {
      type: 'string'
    },

    nodeploy: {
      type: 'boolean',
      defaultsTo: false
    },

    prod: {
      type: 'boolean',
      defaultsTo: false
    },

    skipdeps: {
      type: 'boolean',
      defaultsTo: false
    }

  },


  exits: {

    badArgs: {
      description: 'The given arguments were invalid.'
    },

    notInSailsDir: {
      description: 'It doesn\'t look like the current directory contains a Sails project!'
    },

    notInProduction: {
      description: 'This app specifies that it should only be deployed in production mode.  Try `NODE_ENV=production sails run deploy-serverless`'
    },

    configError: {
      description: 'An error occurred attempting to read a configuration file.'
    }

  },


  fn: async function(inputs, exits) {

    const sails = this.sails;
    const yamljs = require('yamljs');
    const readdir = require('recursive-readdir');
    const babel = require('babel-core');
    const fsx = require('fs-extra');
    const path = require('path');
    const exec = require('child_process').exec;
    const spawn = require('child_process').spawn;

    const cwd = process.cwd();

    // Set up default serverless config.
    sails.config.serverless = _.defaults(sails.config.serverless || {}, {
      include: ['api/helpers', 'api/models', 'config/models.js', 'config/datastores.js'],
      transpile: ['api/helpers', 'api/models'],
      orm: true
    });

    // If deploying a job, always add the job's folder to the list of things to include and transpile.
    if (inputs.j) {
      sails.config.serverless.include = sails.config.serverless.include.concat([`jobs/${inputs.j}`]);
      sails.config.serverless.transpile = sails.config.serverless.transpile.concat([`jobs/${inputs.j}`]);
    }
    // Otherwise add the controllers and authorizers folders to those lists.
    else {
      sails.config.serverless.include = sails.config.serverless.include.concat(['api/controllers','api/authorizers']);
      sails.config.serverless.transpile = sails.config.serverless.transpile.concat(['api/controllers','api/authorizers']);
    }

    // If `requireProd` is true, and we're not in production, bail.
    if (sails.config.serverless.requireProd && process.env.NODE_ENV !== 'production') {
      return exits.notInProduction();
    }

    // Make sure you're in a Sails app folder.
    let packageJson;
    try {
      packageJson = require(path.resolve('.', 'package.json'));
      if ((!packageJson.dependencies || !packageJson.dependencies.sails) && (!packageJson.devDependencies || !packageJson.devDependencies.sails)) {
        throw new Error('No sails!');
      }
    }
    catch (unusedErr) {
      return exits.notInSailsDir();
    }

    // Make sure we're given something to deploy.
    if (!inputs.all && !inputs.f && !inputs.c && !inputs.j) {
      return exits.badArgs('One of `--all`, `--j <job name>` , `--c <controller name>` or `--f <function name>` must be specified.');
    }

    // Make sure we're not given more than one type of thing to deploy.
    if (!!inputs.all + !!inputs.c + !!inputs.f + !!inputs.j > 1) {
      return exits.badArgs('Only one of `--all`, `--j <job name>`, `--c <controller name>` or `--f <function name>` may be specified.');
    }

    // Always set `migrate: safe` so that Lambda functions don't try to run migrations.
    sails.config.models.migrate = 'safe';
    sails.config.models.datastore = 'default';

    // Assume ORM support is wanted until we find otherwise.
    let useOrm = sails.config.serverless.orm;

    // Determine whether to initialize helpers for the deployed code, by checking whether there _are_ any helpers.
    let useHelpers = (() => {

      try {
        let helperFiles = fsx.readdirSync(path.resolve(cwd, 'api', 'helpers'));
        return _.any(helperFiles, (fileName) => { return fileName.match(/^.+\.js/); });
      } catch (e) {
        if (e.code === 'ENOENT') {
          /* ignore */
        }
        else {
          throw e;
        }
      }

    })();


    // Set up the Lambda handler template.
    let handlerTemplate = (() => {
      let bootstrap = [];
      let teardown = [];

      // If we have helpers, make sure they're initialized before the deployed code runs.
      if (useHelpers) {
        bootstrap.push(`require('<%=pathToHelpers%>')`);
      }

      // If we're using the ORM, make sure it's initialized before the deployed code runs.
      if (useOrm) {
        bootstrap.push(`require('<%=pathToWaterline%>')`);
        teardown.push('(cb)=>{sails.hooks.orm.teardown(cb);}');
      }

      // Output the Lodash template function we'll use to output the Lambda function code.
      return _.template(`require('babel-polyfill');\nmodule.exports.fn = require('baggywrinkle')(require('<%=pathToMachine%>'), { bootstrap: [${bootstrap.join(', ')}], teardown: [${teardown.join(', ')}], cors: <%=corsOptions%><%=typeof otherOptions !== 'undefined' ? (', '+otherOptions) : '' %>});\n`);
    })();

    console.log('Cleaning up previous deployments...');

    // Remove any existing serverless directory.
    fsx.removeSync(path.resolve(cwd, 'serverless'));

    console.log('Copying deployment files...');

    // Create the serverless directory.
    fsx.ensureDirSync(path.resolve(cwd, 'serverless'));

    // Remove Sails and any hooks as dependencies unless specifically told not to.
    let keepSailsDeps = _.get(sails.config.serverless, 'keepSailsDeps', []);
    packageJson.dependencies = _.reduce(packageJson.dependencies || {}, (memo, version, packageName) => {
      if ((packageName === 'sails' || packageName.indexOf('sails-hook-') > -1) && !_.contains(keepSailsDeps, packageName)) {
        return memo;
      }
      memo[packageName] = version;
      return memo;
    }, {});

    packageJson.dependencies.baggywrinkle = packageJson.dependencies.baggywrinkle || 'latest';
    packageJson.dependencies['babel-polyfill'] = packageJson.dependencies['babel-polyfill'] || '6.26.0';
    packageJson.dependencies['sails-hook-orm'] = packageJson.dependencies['sails-hook-orm'] || '^2.0.0-22';
    packageJson.dependencies['machine'] = packageJson.dependencies['machine'] || '15.0.0-20';
    packageJson.dependencies['recursive-readdir'] = packageJson.dependencies['recursive-readdir'] || '2.2.1';

    packageJson.devDependencies = {};

    fsx.outputFile(path.resolve(cwd, 'serverless', 'package.json'), JSON.stringify(packageJson));

    // Copy all of the requested folders/files.
    for (let filepath of sails.config.serverless.include) {
      fsx.copySync(path.resolve(cwd, filepath), path.resolve(cwd, 'serverless', filepath));
    }

    // Transpile any files that we're asked to.
    if (sails.config.serverless.transpile) {

      console.log('Transpiling code...');

      for (let filepath of sails.config.serverless.transpile) {
        let filesToTranspile = await readdir(path.resolve(cwd, 'serverless', filepath), [(file) => !!file.match(/\/\.[^\/]+$/)] );
        const transpile = (fileToTranspile, options) => {
          let code = fsx.readFileSync(fileToTranspile).toString();
          code = code.replace(/(fn:.+?\{)([\w\W]+)(\}\s+\})/, '$1 try { $2 } catch (e) { return exits.error(e); } $3');
          return babel.transform(code, options || { presets: ['env'] }).code;
        };
        for (let fileToTranspile of filesToTranspile) {
          let transformedFile = transpile(fileToTranspile);
          fsx.outputFileSync(fileToTranspile, transformedFile);
        }
      }

    }

    //   █████╗  ██████╗████████╗██╗ ██████╗ ███╗   ██╗███████╗
    //  ██╔══██╗██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║██╔════╝
    //  ███████║██║        ██║   ██║██║   ██║██╔██╗ ██║███████╗
    //  ██╔══██║██║        ██║   ██║██║   ██║██║╚██╗██║╚════██║
    //  ██║  ██║╚██████╗   ██║   ██║╚██████╔╝██║ ╚████║███████║
    //  ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝
    //
    // Deploy one or more actions meant to be reached via an HTTP call.

    let serverlessFunctionConfig;

    if (!inputs.j) {

      // Grab the CORS config.
      const globalCorsConfig = sails.config.security.cors;

      // Start an ACL mapping object.
      let resourceMapping = {};

      // Loop through each route.
      serverlessFunctionConfig = _.reduce(sails.config.routes, (memo, target, address) => {

        let actionName = target.action || target;
        if (typeof actionName !== 'string') { return memo; }

        // If we're deploying a specific controller, filter out endpoints that don't use actions from that controller.
        if (inputs.c && actionName.indexOf(`${inputs.c}/`) !== 0) {
          return memo;
        }

        // Parse out the verb and path from the route definition.
        let {verb:routeVerb, path:routePath} = parseAddress(address);

        // Create a lambda-appropriate path.
        let lambdaPath = routePath.replace(/\/:(\w+)/g, '/{$1}');
        if (lambdaPath.match(/\/\*$/)) {
          lambdaPath = lambdaPath.replace(/\/\*$/, '/{0+}');
        }

        // Add an entry to the resource mapping dictionary associating this lambda path with the Sails route address.
        resourceMapping[(routeVerb ? routeVerb.toLowerCase() + ' ' : '') + lambdaPath] = { address, target };

        // Create a function name from the action, e.g. 'user/find' => 'user_find'
        let fnName = _.camelCase(actionName);

        // Start the serverless config for the function.
        memo[fnName] = {
          handler: `functions/${actionName}.fn`,
          events: [
            {
              http: {
                path: lambdaPath,
                method: routeVerb
              }
            }
          ]
        };

        // See if we have any pattern vars or wildcards.
        let params = address.match(/(\/:\w+)|(\/\*)/g);

        if (params) {
          _.set(memo[fnName].events[0].http, 'request.parameters.paths', _.reduce(params, (memo, param) => {
            if (param === '/*') {
              memo['0'] = true;
            }
            else {
              memo[param.substr(2)] = true;
            }
            return memo;
          }, {}));
        }

        // See if we have any local CORS config.
        _.set(memo[fnName].events[0].http, 'cors', (() => {
          if (!_.isUndefined(target.cors) || globalCorsConfig.allRoutes) {
            if (target.cors === false) {
              return undefined;
            }
            let targetCors = target.cors || {};
            if (targetCors === true || globalCorsConfig.allRoutes) {
              return {
                origin: targetCors.allowOrigins || globalCorsConfig.allowOrigins,
                headers: _.map((targetCors.allowRequestHeaders || globalCorsConfig.allowRequestHeaders).split(','), (header) => header.trim()),
                allowCredentials: targetCors.allowCredentials || globalCorsConfig.allowCredentials
              };
            }
          }
          return undefined;
        })());

        if (typeof memo[fnName].events[0].http.cors === 'undefined') {
          delete memo[fnName].events[0].http.cors;
        }

        // See if any authorizer should be applied to this route.
        let authorizer = target.authorizer || (target.authorizer !== false && sails.config.serverless.defaultAuthorizer);
        if (authorizer) {
          memo[fnName].events[0].http.authorizer = {
            name: _.camelCase(`authorizers ${authorizer}`),
            type: 'request',
            resultTtlInSeconds: 0
          };
        }

        // Output a handler.
        let pathToFunction = path.resolve(cwd, 'serverless', 'functions', actionName + '.js');
        let pathToMachine = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'api', 'controllers', actionName + '.js'));
        let pathToWaterline = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-waterline.js'));
        let pathToHelpers = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));

        fsx.outputFileSync(pathToFunction, handlerTemplate({ pathToMachine, pathToHelpers, pathToWaterline, corsOptions: JSON.stringify(_.get(memo[fnName].events[0].http, 'cors', false)) }));

        return memo;

      }, {});

      // If there's an authorizers folder, create functions for everything in it.
      let authorizers;
      try {
        authorizers = await readdir(path.resolve(cwd, 'serverless', 'api', 'authorizers'));
      }
      catch (unusedErr) {
        authorizers = [];
      }

      _.each(authorizers, (authorizerPath) => {
        let filePath = `authorizers/${path.basename(authorizerPath)}`;
        let actionName = filePath.replace(/\.js$/,'');
        let fnName = _.camelCase(actionName);
        let pathToFunction = path.resolve(cwd, 'serverless', 'functions', filePath);
        let pathToMachine = path.relative(path.dirname(pathToFunction), authorizerPath);
        let pathToWaterline = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-waterline.js'));
        let pathToHelpers = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));
        serverlessFunctionConfig[fnName] = {
          handler: `functions/${actionName}.fn`,
        };
        fsx.outputFileSync(pathToFunction, handlerTemplate({ pathToMachine, pathToHelpers, pathToWaterline, corsOptions: true, otherOptions: 'noEnvelope: true' }));
      });

      // Output the resource map.
      fsx.outputFileSync(path.resolve(cwd, 'serverless', 'resources.json'), JSON.stringify(resourceMapping));

    }

    //       ██╗ ██████╗ ██████╗ ███████╗
    //       ██║██╔═══██╗██╔══██╗██╔════╝
    //       ██║██║   ██║██████╔╝███████╗
    //  ██   ██║██║   ██║██╔══██╗╚════██║
    //  ╚█████╔╝╚██████╔╝██████╔╝███████║
    //   ╚════╝  ╚═════╝ ╚═════╝ ╚══════╝
    //
    // Deploy a job meant to be called via a scheduled event (i.e. a cron job).

    let jobConfig = {};
    if (inputs.j) {

      // Read in the job config, if any.
      try {
        jobConfig = require(path.resolve(cwd, 'jobs', inputs.j, 'config.js'));
      } catch (unusedErr) {}

      serverlessFunctionConfig = {
        'job': {
          handler: `functions/job.fn`,
          events: [
            {
              schedule: jobConfig.schedule || 'rate(1 minute)'
            }
          ]
        }
      };

      // Output a handler.
      let pathToFunction = path.resolve(cwd, 'serverless', 'functions', 'job.js');
      let pathToMachine = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'jobs', inputs.j, 'job.js'));
      let pathToWaterline = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-waterline.js'));
      let pathToHelpers = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));

      fsx.outputFileSync(pathToFunction, handlerTemplate({ pathToMachine, pathToHelpers, pathToWaterline, corsOptions: '{}', otherOptions: 'eventType: \'generic\'' }));

    }

    // Load any serverless file template from config.
    let serverlessYml = {};
    try {
      serverlessYml = yamljs.parse(_.template(fsx.readFileSync(path.resolve(cwd, 'config', 'serverless.yml')).toString())({ sails: { config: sails.config } }));
    }
    catch (err) {
      if (err.code !== 'ENOENT') {
        console.log('--------------------------------------------');
        console.log('Error parsing config/serverless.yml:');
        console.log(err.message);
        console.log('--------------------------------------------');
        return exits.configError();
      }
    }

    // If there is a environment-specific yml file, merge it on top.
    try {
      let envServerlessYml = yamljs.parse(_.template(fsx.readFileSync(path.resolve(cwd, 'config', `serverless-${sails.config.environment}.yml`)).toString())({ sails: { config: sails.config } }));
      mergeDictionaries(serverlessYml, envServerlessYml);
    }
    catch (err) {
      if (err.code !== 'ENOENT') {
        console.log('--------------------------------------------');
        console.log(`Error parsing config/serverless-${sails.config.environment}.yml`);
        console.log(err.message);
        console.log('--------------------------------------------');
        return exits.configError();
      }
    }

    // Merge in any options from sails.config.serverless.yml.
    mergeDictionaries(serverlessYml, sails.config.serverless.yml);

    // If this is a job, merge in any options from the job config.
    mergeDictionaries(serverlessYml, jobConfig.serverlessYml || {});

    // Supply some defaults.
    _.defaultsDeep(serverlessYml, {
      service: 'my-service',
      package: {
        excludeDevDependencies: false
      },
      provider: {
        name: 'aws',
        runtime: 'nodejs6.10',
      }
    });

    // Merge in the stuff we just created.
    _.merge(serverlessYml, { functions: serverlessFunctionConfig });

    // If we're deploying a single controller, append the controller name to the service.
    if (inputs.c) {
      serverlessYml.service += '-' + inputs.c;
    }

    // Otherwise append the job name to the service, with the "job" prefix.
    if (inputs.j) {
      serverlessYml.service += `-job-${inputs.j}`;
    }

    // Output the serverless config.
    fsx.outputFileSync(path.resolve(cwd, 'serverless', 'serverless.yml'), yamljs.stringify(serverlessYml, 100, 2).replace(/'<<<(.*?)>>>'/mg,'$1'));

    // Create "initialize-waterline.js", if using the orm.
    if (useOrm) {
      const initalizeWaterlineTemplate = _.template(fsx.readFileSync(path.resolve(__dirname, 'initialize-waterline.js')));
      let initializeWaterlineCode = initalizeWaterlineTemplate({
        modelsConfig: JSON.stringify(sails.config.models),
        datastoresConfig: JSON.stringify(sails.config.datastores)
      });
      fsx.outputFileSync(path.resolve(cwd, 'serverless', 'initialize-waterline.js'), initializeWaterlineCode);
    }

    // Create "initialize-helpers.js", if any helpers are being included.
    try {
      let helperFiles = fsx.readdirSync(path.resolve(cwd, 'api', 'helpers'));
      if (_.any(helperFiles, (fileName) => { return fileName.match(/^.+\.js/); })) {
        fsx.copySync(path.resolve(__dirname, 'initialize-helpers.js'), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        /* ignore */
      }
      else {
        throw e;
      }
    }

    if (inputs.skipdeps) {
      return exits.success('Done!');
    }

    console.log('Installing dependencies...');

    await exec('npm install', {cwd: path.resolve(cwd, 'serverless')}, (err) => {
      if (err) { return exits.error('A problem occurred while installing dependencies: ' + require('util').inspect(err)); }

      if (inputs.nodeploy) {
        return exits.success('Done!');
      }

      let serverlessArgs = ['deploy'];
      if (inputs.f) {
        serverlessArgs = serverlessArgs.concat(['-f', inputs.f]);
      }

      console.log('Starting Serverless deployment...');

      // TODO -- Check for serverless bin and fail gracefully (i.e. 'Please install serverless') if it isn't found.
      let serverlessProcess = spawn('serverless', serverlessArgs, { cwd: path.resolve(cwd, 'serverless')});
      serverlessProcess.stdout.on('data', (data) => {
        process.stdout.write(data);
      });

      serverlessProcess.stderr.on('data', (data) => {
        process.stdout.write(data);
      });

      serverlessProcess.on('close', () => {
        console.log();
        return exits.success('Done!');
      });

    });

  }

};

function parseAddress(haystack) {
  var verbExpr = /^\s*(all|get|post|put|delete|trace|options|connect|patch|head)\s+/i;
  var verbSpecified = _.last(haystack.match(verbExpr) || []) || '';
  verbSpecified = verbSpecified.toLowerCase();

  // If a verb was specified, eliminate the verb from the original string
  if (verbSpecified) {
    haystack = haystack.replace(verbExpr,'').trim();
  } else {
    haystack = haystack.trim();
  }

  return {
    verb: verbSpecified,
    original: haystack,
    path: haystack
  };
}
