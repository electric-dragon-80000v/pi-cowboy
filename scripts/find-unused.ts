#!/usr/bin/env node
// Reports every function or method whose only reference is its own declaration.
// References come from the language service, so a declaration reached only
// through a string key (an oxlint rule visitor), a pi hook, or a cast that
// erases the type link (`ScriptedRunner as unknown as GitCommandRunner` in the
// git-merger tests) reads as unused here. So does every export of a module the
// tests replace wholesale (`vi.mock` of `src/shell.js` for `shell-mock.ts`):
// the call sites name the real module, so none of the mock's members are linked.
//
//   node scripts/find-unused.ts [tsconfig.json]
//   node scripts/find-unused.ts -i "src/foo.ts bar" -i "src/foo.ts Baz.qux"
//   node scripts/find-unused.ts --ignore-all
//   node scripts/find-unused.ts --all
//
// `-i/--ignore` records the signature it names in `scripts/.unused-ignore.txt`
// and suppresses it from this run's output; `--ignore-all` records every symbol
// the run found; `--all` reports everything anyway, ignore list and all. A symbol is identified by its signature — file, enclosing
// class, name, parameter types, return type — never by line number, so an
// ignored symbol stays ignored as the file around it moves.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DB_FILE_NAME = ".unused-ignore.txt";

const DB_HEADER = [
  "# Unused-symbol ignore list, maintained by scripts/find-unused.ts.",
  "# One signature per line: file::[Class.]name(paramTypes): returnType",
  "# Records what `--ignore` and `--ignore-all` were given, not line numbers.",
].join("\n");

const USAGE = [
  "Usage: node scripts/find-unused.ts [options] [tsconfig.json]",
  "",
  "Reports functions and methods whose only reference is their declaration.",
  "",
  "Options:",
  "  -i, --ignore <symbol>  Ignore a found symbol; repeatable. <symbol> is a",
  '                         full signature, "<file> <name>", or a bare <name>.',
  "                         Only symbols this run found are recorded.",
  "      --ignore-all       Ignore every symbol this run found.",
  "  -a, --all              Report every found symbol, ignore list and all.",
  "  -h, --help             Show this message.",
  "",
  `Ignored signatures live in scripts/${DB_FILE_NAME}.`,
].join("\n");

interface Project {
  readonly program: ts.Program;
  readonly service: ts.LanguageService;
}

/** A found symbol's identity: what it is, independent of where it sits. */
interface Signature {
  readonly file: string;
  readonly owner: string | null;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly returns: string;
}

interface DeadFunction {
  readonly signature: Signature;
  readonly line: number;
}

type DeclaredFunction =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

interface Candidate {
  readonly declaration: DeclaredFunction;
  readonly name: ts.Identifier;
}

interface Options {
  readonly configPath: string;
  readonly ignoreSpecs: readonly string[];
  readonly ignoreAll: boolean;
  readonly includeIgnored: boolean;
  readonly help: boolean;
}

/** The one-line form a signature is stored and matched under. */
function signatureIdentity(signature: Signature): string {
  const owner = signature.owner === null ? "" : `${signature.owner}.`;
  const parameters = signature.parameters.join(", ");
  return `${signature.file}::${owner}${signature.name}(${parameters}): ${signature.returns}`;
}

/** The declaration a node introduces, or null if it introduces no function. */
function declaredFunction(node: ts.Node): Candidate | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    // A decorated declaration is reached through its decorators, which the
    // reference lookup does not follow.
    if (ts.canHaveDecorators(node) && ts.getDecorators(node)?.length)
      return null;
    const { name } = node;
    return name !== undefined && ts.isIdentifier(name)
      ? { declaration: node, name }
      : null;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    return { declaration: node.initializer, name: node.name };
  }
  return null;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** The class name children of `node` belong to, carried down the walk. */
function childOwner(node: ts.Node, owner: string | null): string | null {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name === undefined ? null : node.name.getText();
  }
  // A function between a class and a declaration means the declaration is not
  // the class's member — a closure that happens to sit inside it.
  return isFunctionLike(node) ? null : owner;
}

function toRepoPath(fileName: string): string {
  return path.relative(process.cwd(), fileName).split(path.sep).join("/");
}

function signatureOf(
  declaration: DeclaredFunction,
  name: ts.Identifier,
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  owner: string | null,
): Signature {
  const signature = checker.getSignatureFromDeclaration(declaration);
  return {
    file: toRepoPath(file.fileName),
    owner,
    name: name.getText(file),
    parameters: declaration.parameters.map((parameter) =>
      checker.typeToString(checker.getTypeAtLocation(parameter)),
    ),
    returns:
      signature === undefined
        ? ""
        : checker.typeToString(signature.getReturnType()),
  };
}

/** Build a language service over the config's file list and its compiler options. */
function openProject(configPath: string): Project {
  const configDir = path.dirname(path.resolve(configPath));
  const sys = ts.sys;
  const { config, error } = ts.readConfigFile(configPath, (fileName) =>
    sys.readFile(fileName),
  );
  if (error)
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config, sys, configDir);

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      const text = sys.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => configDir,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    // The host calls these detached from `sys`.
    fileExists: (fileName) => sys.fileExists(fileName),
    readFile: (fileName, encoding) => sys.readFile(fileName, encoding),
    readDirectory: (dirName, extensions, exclude, include, depth) =>
      sys.readDirectory(dirName, extensions, exclude, include, depth),
    directoryExists: (dirName) => sys.directoryExists(dirName),
    getDirectories: (dirName) => sys.getDirectories(dirName),
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  if (program === undefined) {
    throw new Error(`the language service built no program for ${configPath}`);
  }
  return { program, service };
}

function findDeadFunctions({ program, service }: Project): DeadFunction[] {
  const checker = program.getTypeChecker();
  const dead: DeadFunction[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes("node_modules"))
      continue;

    const visit = (node: ts.Node, owner: string | null): void => {
      const candidate = declaredFunction(node);
      if (candidate !== null) {
        const start = candidate.name.getStart(file);
        const references =
          service.getReferencesAtPosition(file.fileName, start) ?? [];
        // The declaration's own name counts as one reference, so only that one
        // means nothing else in the program names it.
        if (references.length < 2) {
          dead.push({
            signature: signatureOf(
              candidate.declaration,
              candidate.name,
              file,
              checker,
              owner,
            ),
            line: file.getLineAndCharacterOfPosition(start).line + 1,
          });
        }
      }
      const child = childOwner(node, owner);
      ts.forEachChild(node, (next) => visit(next, child));
    };
    ts.forEachChild(file, (node) => visit(node, null));
  }
  return dead;
}

function databasePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), DB_FILE_NAME);
}

function loadIgnored(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  return new Set(
    lines
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
}

function saveIgnored(filePath: string, identities: ReadonlySet<string>): void {
  const body = [...identities].sort().join("\n");
  fs.writeFileSync(filePath, `${DB_HEADER}\n${body}\n`);
}

function normalizeFile(file: string): string {
  return file.replace(/^\.\//, "").split(path.sep).join("/");
}

/** Whether an ignore spec names a signature: exactly, as "<file> <name>", or by name. */
function matchesSpec(signature: Signature, spec: string): boolean {
  if (spec === signatureIdentity(signature)) return true;
  const tokens = spec.trim().split(/\s+/);
  if (tokens[0] === "") return false;
  const file = tokens.length === 1 ? null : normalizeFile(tokens[0]);
  if (file !== null && file !== signature.file) return false;
  const name = tokens.length === 1 ? tokens[0] : tokens.slice(1).join(" ");
  const qualified =
    signature.owner === null
      ? signature.name
      : `${signature.owner}.${signature.name}`;
  return name === signature.name || name === qualified;
}

function parseArgs(argv: readonly string[]): Options {
  const ignoreSpecs: string[] = [];
  let ignoreAll = false;
  let includeIgnored = false;
  let help = false;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--ignore-all") {
      ignoreAll = true;
      continue;
    }
    if (argument === "--all" || argument === "-a") {
      includeIgnored = true;
      continue;
    }
    if (argument === "--ignore" || argument === "-i") {
      if (index + 1 >= argv.length)
        throw new Error(`${argument} needs a value`);
      ignoreSpecs.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--ignore=")) {
      ignoreSpecs.push(argument.slice("--ignore=".length));
      continue;
    }
    if (argument.startsWith("-i=")) {
      ignoreSpecs.push(argument.slice("-i=".length));
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`unknown option: ${argument}`);
    if (configPath !== undefined)
      throw new Error(`unexpected argument: ${argument}`);
    configPath = argument;
  }
  return {
    configPath: configPath ?? "tsconfig.json",
    ignoreSpecs,
    ignoreAll,
    includeIgnored,
    help,
  };
}

function main(): number {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Try --help.");
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const found = findDeadFunctions(openProject(options.configPath));
  const dbPath = databasePath();
  const ignored = loadIgnored(dbPath);

  // `--ignore-all` and `-i` take the same path: both collect the signatures of
  // found symbols, which the DB is then merged with and the output filtered by.
  const additions = new Set<string>();
  if (options.ignoreAll) {
    for (const entry of found)
      additions.add(signatureIdentity(entry.signature));
  }
  const unresolved: string[] = [];
  for (const spec of options.ignoreSpecs) {
    const matches = found.filter((entry) => matchesSpec(entry.signature, spec));
    if (matches.length === 0) unresolved.push(spec);
    for (const match of matches)
      additions.add(signatureIdentity(match.signature));
  }

  if ([...additions].some((identity) => !ignored.has(identity))) {
    saveIgnored(dbPath, new Set([...ignored, ...additions]));
  }

  const knownIgnored = new Set([...ignored, ...additions]);
  const visible = found
    .filter(
      (entry) =>
        options.includeIgnored ||
        !knownIgnored.has(signatureIdentity(entry.signature)),
    )
    .sort(
      (a, b) =>
        a.signature.file.localeCompare(b.signature.file) || a.line - b.line,
    );

  for (const entry of visible) {
    console.log(
      `${entry.signature.file}:${entry.line}  ${entry.signature.name}`,
    );
  }

  const ignoredCount = found.filter((entry) =>
    knownIgnored.has(signatureIdentity(entry.signature)),
  ).length;
  console.error(
    `\n${visible.length} candidates${ignoredCount > 0 ? ` (${ignoredCount} ignored)` : ""}`,
  );
  for (const spec of unresolved) {
    console.error(`no found symbol matches ignore spec: ${spec}`);
  }
  return unresolved.length > 0 ? 1 : 0;
}

process.exitCode = main();
