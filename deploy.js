// @ts-check
import { getInput, setFailed, info } from "@actions/core";
import * as glob from "@actions/glob";
import { writeFileSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * @typedef {{ identityFile: string, port: string, username: string, host: string }} SshTarget
 * @typedef {{ identityFile: string, port: string, files: string[], destination: string }} ScpCopy
 * @typedef {{ proxyKeyFile: string, proxyPort: string, proxyUsername: string, proxyHost: string }} ProxyConnection
 * @typedef {{ files: string[], proxyStageDir: string }} ProxyStage
 * @typedef {{ files: string[], proxyStageDir: string, proxyKeyFile: string, proxyPort: string, proxyUsername: string, proxyHost: string }} ProxyStageCopy
 * @typedef {{ files: string[], proxyStageDir: string, proxyKeyPath: string, port: string, username: string, host: string, target: string }} ProxyTargetCopy
 * @typedef {{ proxySshArgs: string[], files: string[], proxyStageDir: string, proxyKeyPath: string, port: string, username: string, host: string, target: string }} ProxyTargetCopyCommand
 * @typedef {{ proxyKeyPath: string, port: string, username: string, host: string }} ProxyTarget
 * @typedef {{ proxySshArgs: string[], proxyKeyPath: string, port: string, username: string, host: string, script: string }} ProxyTargetScript
 * @typedef {{ commonArgs: string[], port: string, files: string[], username: string, host: string, target: string }} DirectCopy
 * @typedef {{ commonArgs: string[], port: string, username: string, host: string, script: string }} DirectScript
 */

/**
 * Creates a temporary file containing the private key content with 600 permissions.
 * @param {string} keyContent - The SSH private key string content.
 * @returns {string} The path to the created temporary key file.
 */
function createTempKeyFile(keyContent) {
  const filename = `ssh-key-${crypto.randomBytes(8).toString("hex")}.pem`;
  const filePath = join(tmpdir(), filename);
  const content = keyContent.endsWith("\n") ? keyContent : `${keyContent}\n`;
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o600);
  return filePath;
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding | import("node:child_process").SpawnSyncOptions} options
 * @param {string} errorMessage
 * @returns {import("node:child_process").SpawnSyncReturns<string | Buffer>}
 */
function runCommand(command, args, options, errorMessage) {
  const result = spawnSync(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${errorMessage} with exit code ${result.status}`);
  }
  return result;
}

/**
 * @param {string} identityFile
 * @returns {string[]}
 */
function getBaseSshOptions(identityFile) {
  return [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=30",
    "-o",
    `IdentityFile=${identityFile}`,
  ];
}

/**
 * @param {SshTarget} target
 * @returns {string[]}
 */
function getSshTargetArgs(target) {
  return [
    ...getBaseSshOptions(target.identityFile),
    "-p",
    target.port,
    `${target.username}@${target.host}`,
  ];
}

/**
 * @param {ScpCopy} copy
 * @returns {string[]}
 */
function getScpArgs(copy) {
  return [
    ...getBaseSshOptions(copy.identityFile),
    "-P",
    copy.port,
    "-r",
    ...copy.files,
    copy.destination,
  ];
}

/**
 * @param {ProxyConnection} proxy
 * @returns {string}
 */
function getProxyCommand(proxy) {
  return [
    "ssh -W %h:%p",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    `-o IdentityFile="${proxy.proxyKeyFile}"`,
    `-p ${proxy.proxyPort}`,
    `${proxy.proxyUsername}@${proxy.proxyHost}`,
  ].join(" ");
}

/**
 * @param {string[]} sshArgs
 * @param {string} remoteCommand
 */
function runRemoteCleanup(sshArgs, remoteCommand) {
  spawnSync("ssh", [...sshArgs, remoteCommand], { stdio: "inherit" });
}

/**
 * @param {string[]} scpArgs
 * @param {string} errorMessage
 */
function runScp(scpArgs, errorMessage) {
  runCommand("scp", scpArgs, { stdio: "inherit" }, errorMessage);
}

/**
 * @param {string[]} sshArgs
 * @returns {string}
 */
function createProxyStageDir(sshArgs) {
  const result = runCommand(
    "ssh",
    [...sshArgs, "mktemp -d /tmp/remote-deploy.XXXXXX"],
    { encoding: "utf-8" },
    "Proxy staging directory creation failed",
  );
  return String(result.stdout).trim();
}

/**
 * @param {ProxyStageCopy} copy
 */
function copyFilesToProxy(copy) {
  runScp(
    getScpArgs({
      identityFile: copy.proxyKeyFile,
      port: copy.proxyPort,
      files: copy.files,
      destination: `${copy.proxyUsername}@${copy.proxyHost}:${copy.proxyStageDir}/`,
    }),
    "SCP copy to proxy failed",
  );
}

/**
 * @param {ProxyStage} stage
 * @returns {string}
 */
function getStagedProxyPaths(stage) {
  return stage.files
    .map((file) => `${stage.proxyStageDir}/${basename(file)}`)
    .map(shellQuote)
    .join(" ");
}

/**
 * @param {ProxyTargetCopy} copy
 * @returns {string}
 */
function getProxyToTargetScpCommand(copy) {
  return [
    "scp",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o ConnectTimeout=30",
    `-i ${shellQuote(copy.proxyKeyPath)}`,
    `-P ${shellQuote(copy.port)}`,
    "-r",
    getStagedProxyPaths({
      files: copy.files,
      proxyStageDir: copy.proxyStageDir,
    }),
    shellQuote(`${copy.username}@${copy.host}:${copy.target}`),
  ].join(" ");
}

/**
 * @param {ProxyTargetCopyCommand} copy
 */
function copyFilesFromProxyToTarget(copy) {
  runCommand(
    "ssh",
    [
      ...copy.proxySshArgs,
      getProxyToTargetScpCommand({
        files: copy.files,
        proxyStageDir: copy.proxyStageDir,
        proxyKeyPath: copy.proxyKeyPath,
        port: copy.port,
        username: copy.username,
        host: copy.host,
        target: copy.target,
      }),
    ],
    { stdio: "inherit" },
    "SCP copy from proxy to target failed",
  );
}

/**
 * @param {ProxyTarget} target
 * @returns {string}
 */
function getProxyTargetSshCommand(target) {
  return [
    "ssh",
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o ConnectTimeout=30",
    `-i ${shellQuote(target.proxyKeyPath)}`,
    `-p ${shellQuote(target.port)}`,
    "-T",
    shellQuote(`${target.username}@${target.host}`),
    "bash -s",
  ].join(" ");
}

/**
 * @param {ProxyTargetScript} target
 */
function runTargetScriptFromProxy(target) {
  runCommand(
    "ssh",
    [
      ...target.proxySshArgs,
      getProxyTargetSshCommand({
        proxyKeyPath: target.proxyKeyPath,
        port: target.port,
        username: target.username,
        host: target.host,
      }),
    ],
    {
      input: target.script,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf-8",
    },
    "SSH script execution failed",
  );
}

/**
 * @param {DirectCopy} copy
 */
function copyFilesDirectly(copy) {
  runScp(
    [
      ...copy.commonArgs,
      "-P",
      copy.port,
      "-r",
      ...copy.files,
      `${copy.username}@${copy.host}:${copy.target}`,
    ],
    "SCP copy failed",
  );
}

/**
 * @param {DirectScript} target
 */
function runTargetScriptDirectly(target) {
  runCommand(
    "ssh",
    [
      ...target.commonArgs,
      "-p",
      target.port,
      "-T",
      `${target.username}@${target.host}`,
      "bash -s",
    ],
    {
      input: target.script,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf-8",
    },
    "SSH script execution failed",
  );
}

/**
 * Validates the inputs, prepares the key files, executes SCP and/or SSH script,
 * and ensures cleanup of the temporary key files.
 */
async function run() {
  let tempTargetKeyFile = "";
  let tempProxyKeyFile = "";

  try {
    // Get Action inputs
    const host = getInput("host", { required: true });
    const username = getInput("username", { required: true });
    const port = getInput("port") || "22";
    const key = getInput("key");
    const keyPath = getInput("key_path");
    const source = getInput("source");
    const target = getInput("target");
    const script = getInput("script");

    const proxyHost = getInput("proxy_host");
    const proxyUsername = getInput("proxy_username");
    const proxyPort = getInput("proxy_port") || "22";
    const proxyKey = getInput("proxy_key");
    const proxyKeyPath = getInput("proxy_key_path");

    const useProxyHostedTargetKey = Boolean(proxyHost && proxyKeyPath);

    // Validate input combinations
    if (!useProxyHostedTargetKey && !key && !keyPath) {
      throw new Error(
        "Validation Error: Either 'key' or 'key_path' must be provided.",
      );
    }

    if (proxyHost) {
      if (!proxyUsername) {
        throw new Error(
          "Validation Error: 'proxy_username' is required when 'proxy_host' is provided.",
        );
      }
      if (!useProxyHostedTargetKey && !proxyKey) {
        throw new Error(
          "Validation Error: 'proxy_key' must be provided when 'proxy_host' is provided without 'proxy_key_path'.",
        );
      }
      if (useProxyHostedTargetKey && !proxyKey && !key && !keyPath) {
        throw new Error(
          "Validation Error: 'key', 'key_path', or 'proxy_key' must be provided to connect to 'proxy_host'.",
        );
      }
    }

    if (source || target) {
      if (!source || !target) {
        throw new Error(
          "Validation Error: Both 'source' and 'target' must be provided for SCP copy.",
        );
      }
    }

    if (!source && !script) {
      throw new Error(
        "Validation Error: Either 'source' (for SCP) or 'script' (for SSH command) must be provided.",
      );
    }

    // Handle private keys
    let targetKeyFile = "";
    if (key) {
      tempTargetKeyFile = createTempKeyFile(key);
      targetKeyFile = tempTargetKeyFile;
    } else if (keyPath) {
      if (!existsSync(keyPath)) {
        throw new Error(`Target key_path file does not exist: ${keyPath}`);
      }
      targetKeyFile = keyPath;
    }

    let proxyKeyFile = "";
    if (proxyHost) {
      if (proxyKey) {
        tempProxyKeyFile = createTempKeyFile(proxyKey);
        proxyKeyFile = tempProxyKeyFile;
      } else {
        proxyKeyFile = targetKeyFile;
      }
    }

    const proxyArgs = getSshTargetArgs({
      identityFile: proxyKeyFile,
      port: proxyPort,
      username: proxyUsername,
      host: proxyHost,
    });

    if (useProxyHostedTargetKey) {
      let proxyStageDir = "";

      try {
        if (source && target) {
          info("Resolving source files using glob...");
          const globber = await glob.create(source);
          const files = await globber.glob();

          if (files.length === 0) {
            throw new Error(
              `No files or directories found matching source pattern: ${source}`,
            );
          }

          info(`Resolved ${files.length} paths to copy. Staging on proxy...`);

          proxyStageDir = createProxyStageDir(proxyArgs);
          copyFilesToProxy({
            files,
            proxyStageDir,
            proxyKeyFile,
            proxyPort,
            proxyUsername,
            proxyHost,
          });

          info("Copying staged files from proxy to target...");
          copyFilesFromProxyToTarget({
            proxySshArgs: proxyArgs,
            files,
            proxyStageDir,
            proxyKeyPath,
            port,
            username,
            host,
            target,
          });
          info("SCP copy completed successfully.");
        }

        if (script) {
          info("Executing script on target via proxy-host key...");
          runTargetScriptFromProxy({
            proxySshArgs: proxyArgs,
            proxyKeyPath,
            port,
            username,
            host,
            script,
          });
          info("SSH script execution completed successfully.");
        }
      } finally {
        if (proxyStageDir) {
          runRemoteCleanup(proxyArgs, `rm -rf ${shellQuote(proxyStageDir)}`);
        }
      }

      return;
    }

    // Construct common SSH/SCP arguments
    const commonArgs = getBaseSshOptions(targetKeyFile);

    if (proxyHost) {
      commonArgs.push(
        "-o",
        `ProxyCommand=${getProxyCommand({
          proxyKeyFile,
          proxyPort,
          proxyUsername,
          proxyHost,
        })}`,
      );
    }

    // Run SCP file copy if source/target are provided
    if (source && target) {
      info("Resolving source files using glob...");
      const globber = await glob.create(source);
      const files = await globber.glob();

      if (files.length === 0) {
        throw new Error(
          `No files or directories found matching source pattern: ${source}`,
        );
      }

      info(`Resolved ${files.length} paths to copy. Executing SCP copy...`);

      copyFilesDirectly({ commonArgs, port, files, username, host, target });
      info("SCP copy completed successfully.");
    }

    // Run SSH script if provided
    if (script) {
      info("Executing script on remote host via SSH...");

      runTargetScriptDirectly({ commonArgs, port, username, host, script });
      info("SSH script execution completed successfully.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setFailed(message);
  } finally {
    // Cleanup temporary files
    if (tempTargetKeyFile) {
      try {
        unlinkSync(tempTargetKeyFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        info(
          `Warning: Failed to delete temporary target key file: ${message}`,
        );
      }
    }
    if (tempProxyKeyFile) {
      try {
        unlinkSync(tempProxyKeyFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        info(
          `Warning: Failed to delete temporary proxy key file: ${message}`,
        );
      }
    }
  }
}

run();
