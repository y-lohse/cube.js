/*
eslint import/no-dynamic-require: 0
 */
/*
eslint global-require: 0
 */
const program = require('commander');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const spawn = require('cross-spawn');
const crypto = require('crypto');
const Analytics = require('analytics-node');

const client = new Analytics('dSR8JiNYIGKyQHKid9OaLYugXLao18hA', { flushInterval: 100 });
const { machineIdSync } = require('node-machine-id');
const { promisify } = require('util');
const templates = require('./templates');

const packageJson = require('./package.json');

program.name(Object.keys(packageJson.bin)[0])
  .version(packageJson.version);

const executeCommand = (command, args) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('close', code => {
      if (code !== 0) {
        reject({
          command: `${command} ${args.join(' ')}`,
        });
        return;
      }
      resolve();
    });
  });
};

const anonymousId = machineIdSync();

const event = async (name, props) => {
  try {
    client.track({
      event: name,
      anonymousId,
      properties: props
    });
    await promisify(client.flush.bind(client))();
  } catch (e) {
    // ignore
  }
};

const writePackageJson = async (json) => fs.writeJson('package.json', json, {
  spaces: 2,
  EOL: os.EOL
});

const displayError = async (text, options) => {
  console.error('');
  console.error(chalk.cyan('Cube.js Error ---------------------------------------'));
  console.error('');
  if (Array.isArray(text)) {
    text.forEach((str) => console.error(str));
  } else {
    console.error(text);
  }
  console.error('');
  console.error(chalk.yellow('Need some help? -------------------------------------'));
  await event('Error', { error: Array.isArray(text) ? text.join('\n') : text.toString(), ...options });
  console.error('');
  console.error(`${chalk.yellow(`  Ask this question in Cube.js Slack:`)} https://publicslack.com/slacks/cubejs/invites/new`);
  console.error(`${chalk.yellow(`  Post an issue:`)} https://github.com/statsbotco/cube.js/issues`);
  console.error('');
  process.exit(1);
};

const requireFromPackage = (module) => require(path.join(process.cwd(), 'node_modules', module));

const npmInstall = (dependencies) => executeCommand('npm', ['install', '--save'].concat(dependencies));

const logStage = (stage) => {
  console.log(`- ${stage}`);
};

const createApp = async (projectName, options) => {
  const createAppOptions = { projectName, dbType: options.dbType };
  event('Create App', createAppOptions);
  if (!options.dbType) {
    await displayError([
      "You must pass an application name and a database type (-d).",
      "",
      "Example: ",
      " $ cubejs create hello-world -d postgres"
    ], createAppOptions);
  }
  if (await fs.pathExists(projectName)) {
    await displayError(
      `We cannot create a project called ${chalk.green(
        projectName
      )}: directory already exist.\n`,
      createAppOptions
    );
  }
  const template = options.template || 'express';
  if (!templates[template]) {
    await displayError(
      `Unknown template ${chalk.red(template)}`,
      createAppOptions
    );
  }
  await fs.ensureDir(projectName);
  process.chdir(projectName);

  logStage('Creating project structure');
  await writePackageJson({
    name: projectName,
    version: '0.0.1',
    private: true,
    scripts: {
      dev: "./node_modules/.bin/cubejs-dev-server"
    }
  });

  logStage('Installing server dependencies');
  await npmInstall(['@cubejs-backend/server']);

  logStage('Installing DB driver dependencies');
  const CubejsServer = requireFromPackage('@cubejs-backend/server');
  let driverDependencies = CubejsServer.driverDependencies(options.dbType);
  driverDependencies = Array.isArray(driverDependencies) ? driverDependencies : [driverDependencies];
  if (driverDependencies[0] === '@cubejs-backend/jdbc-driver') {
    driverDependencies.push('node-java-maven');
  }
  await npmInstall(driverDependencies);

  if (driverDependencies[0] === '@cubejs-backend/jdbc-driver') {
    logStage('Installing JDBC dependencies');
    const JDBCDriver = require(path.join(process.cwd(), 'node_modules', '@cubejs-backend', 'jdbc-driver', 'driver', 'JDBCDriver'));
    const dbTypeDescription = JDBCDriver.dbTypeDescription(options.dbType);
    if (!dbTypeDescription) {
      await displayError(`Unsupported db type: ${chalk.green(options.dbType)}`, createAppOptions);
    }

    const newPackageJson = await fs.readJson('package.json');
    if (dbTypeDescription.mavenDependency) {
      newPackageJson.java = {
        dependencies: [dbTypeDescription.mavenDependency]
      };
    }
    newPackageJson.scripts = newPackageJson.scripts || {};
    newPackageJson.scripts.install = './node_modules/.bin/node-java-maven';
    await writePackageJson(newPackageJson);

    await executeCommand('npm', ['install']);
  }

  logStage('Writing files from template');

  const templateConfig = templates[template];
  const env = {
    dbType: options.dbType,
    apiSecret: crypto.randomBytes(64).toString('hex'),
    projectName
  };
  await Promise.all(Object.keys(templateConfig.files).map(async fileName => {
    await fs.ensureDir(path.dirname(fileName));
    await fs.writeFile(fileName, templateConfig.files[fileName](env));
  }));

  if (templateConfig.dependencies) {
    logStage('Installing template dependencies');
    await npmInstall(templateConfig.dependencies);
  }

  await event('Create App Success', { projectName, dbType: options.dbType });
  logStage(`${chalk.green(projectName)} app has been created 🎉`);

  console.log();
  console.log(`📊 Next steps:`);
  console.log(`1. Generate schema:`);
  console.log();
  console.log(`     $ cd ${projectName}`);
  console.log(`     $ cubejs generate -t orders,customers`);
  console.log();
  console.log(`2. Run dev server:`);
  console.log();
  console.log(`     $ npm run dev`);
  console.log();
};

const generateSchema = async (options) => {
  const generateSchemaOptions = { tables: options.tables };
  event('Generate Schema', generateSchemaOptions);
  if (!options.tables) {
    await displayError([
      "You must pass table names to generate schema from (-t).",
      "",
      "Example: ",
      " $ cubejs generate -t orders,customers"
    ], generateSchemaOptions);
  }
  if (!(await fs.pathExists(path.join(process.cwd(), 'node_modules', '@cubejs-backend/server')))) {
    await displayError(
      "@cubejs-backend/server dependency not found. Please run generate command from project directory.",
      generateSchemaOptions
    );
  }

  logStage('Fetching DB schema');
  const CubejsServer = requireFromPackage('@cubejs-backend/server');
  const driver = await CubejsServer.createDriver();
  await driver.testConnection();
  const dbSchema = await driver.tablesSchema();
  if (driver.release) {
    await driver.release();
  }

  logStage('Generating schema files');
  const ScaffoldingTemplate = requireFromPackage('@cubejs-backend/schema-compiler/scaffolding/ScaffoldingTemplate');
  const scaffoldingTemplate = new ScaffoldingTemplate(dbSchema);
  const files = scaffoldingTemplate.generateFilesByTableNames(options.tables);
  await Promise.all(files.map(file => fs.writeFile(path.join('schema', file.fileName), file.content)));

  await event('Generate Schema Success', generateSchemaOptions);
  logStage(`Schema for ${options.tables.join(', ')} was successfully generated 🎉`);
};

program
  .usage('<command> [options]')
  .on('--help', () => {
    console.log('');
    console.log('Use cubejs <command> --help for more information about a command.');
    console.log('');
  });

program
  .command('create <name>')
  .option('-d, --db-type <db-type>', 'Preconfigure for selected database. Options: postgres, mysql, athena')
  .option('-t, --template <template>', 'App template. Options: express (default), serverless.')
  .description('Create new Cube.js app')
  .action(
    (projectName, options) => createApp(projectName, options)
      .catch(e => displayError(e.stack || e, { projectName, dbType: options.dbType }))
  )
  .on('--help', () => {
    console.log('');
    console.log('Examples:');
    console.log('');
    console.log('  $ cubejs create hello-world -d postgres');
  });

const list = (val) => val.split(',');

program
  .command('generate')
  .option('-t, --tables <tables>', 'Comma delimited list of tables to generate schema from', list)
  .description('Generate Cube.js schema from DB tables schema')
  .action(
    (options) => generateSchema(options).catch(e => displayError(e.stack || e, { dbType: options.dbType }))
  )
  .on('--help', () => {
    console.log('');
    console.log('Examples:');
    console.log('');
    console.log('  $ cubejs generate -t orders,customers');
  });

if (!process.argv.slice(2).length) {
  program.help();
}

program.parse(process.argv);
