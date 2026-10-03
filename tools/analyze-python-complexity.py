"""Independently authored, non-executing complexity analysis using Python's AST."""

import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
import tokenize


def executable(node):
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))


def anonymous_name(node, parents):
    parent = parents.get(node)
    if isinstance(parent, ast.Assign):
        return "lambda:" + ast.unparse(parent.targets[0])
    if isinstance(parent, ast.AnnAssign):
        return "lambda:" + ast.unparse(parent.target)
    if isinstance(parent, ast.Call):
        return "callback:" + ast.unparse(parent.func)
    return "<anonymous>"


def count_decisions(root):
    decisions = Counter()

    def visit(node):
        if executable(node):
            return
        kinds = {
            ast.If: "if", ast.IfExp: "conditional expression", ast.For: "for",
            ast.AsyncFor: "async-for", ast.While: "while", ast.ExceptHandler: "except", ast.Assert: "assert",
        }
        if type(node) in kinds:
            decisions[kinds[type(node)]] += 1
        if isinstance(node, ast.BoolOp):
            decisions["and" if isinstance(node.op, ast.And) else "or"] += len(node.values) - 1
        if isinstance(node, ast.Compare) and len(node.ops) > 1:
            decisions["chained comparison"] += len(node.ops) - 1
        if isinstance(node, ast.comprehension):
            decisions["comprehension for"] += 1
            decisions["comprehension filter"] += len(node.ifs)
        if isinstance(node, ast.match_case):
            if not isinstance(node.pattern, ast.MatchAs) or node.pattern.pattern is not None:
                decisions["non-default match case"] += 1
            if node.guard is not None:
                decisions["match guard"] += 1
        if isinstance(node, ast.MatchOr):
            decisions["or pattern"] += len(node.patterns) - 1
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in root:
        visit(statement)
    return {"complexity": 1 + sum(decisions.values()), "decisions": dict(decisions)}


def analyze_file(root, relative):
    full = (root / relative).resolve()
    if not full.is_relative_to(root) or full.suffix != ".py" or full.is_symlink():
        raise ValueError("Python input must name an authored source file inside its analysis root")
    raw = full.read_bytes()
    with full.open("rb") as stream:
        encoding, _ = tokenize.detect_encoding(stream.readline)
    text = raw.decode(encoding)
    tree = ast.parse(text, filename=relative, type_comments=True)
    # Validate control-flow placement and signatures without executing any code.
    compile(tree, relative, "exec", dont_inherit=True)
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    occurrences = Counter()
    functions = [{"file": relative, "name": "<module>", "occurrence": 1, "line": 1, "column": 1,
                  "endLine": max(1, len(text.splitlines())), **count_decisions(tree.body)}]

    def visit(node, scope):
        children_scope = scope
        if isinstance(node, ast.ClassDef):
            children_scope = [*scope, node.name]
        if executable(node):
            local = anonymous_name(node, parents) if isinstance(node, ast.Lambda) else node.name
            name = " / ".join([*scope, local])
            occurrences[name] += 1
            body = [node.body] if isinstance(node, ast.Lambda) else node.body
            functions.append({"file": relative, "name": name, "occurrence": occurrences[name],
                              "line": node.lineno, "column": node.col_offset + 1,
                              "endLine": node.end_lineno, **count_decisions(body)})
            children_scope = [*scope, local]
        for child in ast.iter_child_nodes(node):
            visit(child, children_scope)

    visit(tree, [])
    return {"file": relative, "sha256": hashlib.sha256(raw).hexdigest(), "lines": len(text.splitlines()), "functions": functions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    root = Path(options.root).resolve()
    paths = json.loads(Path(options.input).read_text(encoding="utf-8"))
    if not isinstance(paths, list) or not paths or any(not isinstance(item, str) for item in paths) or len(set(paths)) != len(paths):
        raise ValueError("Python input manifest must contain unique source file names")
    files = [analyze_file(root, relative) for relative in paths]
    report = {"version": 1, "language": "python", "analyzer": f"Python {sys.version.split()[0]} stdlib ast",
              "files": files, "functions": [function for file in files for function in file["functions"]]}
    Path(options.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, SyntaxError, TypeError) as error:
        print(f"Python complexity analysis failed: {error}", file=sys.stderr)
        sys.exit(1)
