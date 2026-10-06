/**
 * Dependency Resolver
 *
 * Builds dependency graphs, detects cycles, and resolves import order
 * for AutoHotkey library files using topological sorting.
 */

import path from 'path';
import type {
  LibraryMetadata,
  DependencyResolution,
  VersionConflict,
} from '../types/library-types.js';

/**
 * Resolves library dependencies and import order
 */
export class DependencyResolver {
  /** Adjacency list representation of dependency graph */
  private graph: Map<string, string[]> = new Map();

  /** Reverse graph for finding dependents */
  private reverseGraph: Map<string, string[]> = new Map();

  /** Library metadata for version checking */
  private libraries: Map<string, LibraryMetadata> = new Map();

  /**
   * Build dependency graph from library metadata
   *
   * @param libraries - Array of library metadata
   */
  buildGraph(libraries: LibraryMetadata[]): void {
    this.graph.clear();
    this.reverseGraph.clear();
    this.libraries.clear();

    // Initialize graph nodes
    for (const lib of libraries) {
      this.graph.set(lib.name, lib.dependencies);
      this.libraries.set(lib.name, lib);

      // Build reverse graph
      if (!this.reverseGraph.has(lib.name)) {
        this.reverseGraph.set(lib.name, []);
      }

      for (const dep of lib.dependencies) {
        if (!this.reverseGraph.has(dep)) {
          this.reverseGraph.set(dep, []);
        }
        this.reverseGraph.get(dep)?.push(lib.name);
      }
    }
  }

  /**
   * Detect circular dependencies using DFS
   *
   * @returns Array of cycles, where each cycle is an array of library names
   */
  detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    for (const [node, _] of this.graph) {
      if (!visited.has(node)) {
        this.dfs(node, visited, recursionStack, path, cycles);
      }
    }

    return cycles;
  }

  /**
   * Depth-first search for cycle detection
   *
   * @param node - Current node
   * @param visited - Set of visited nodes
   * @param recursionStack - Current recursion path
   * @param path - Current path being explored
   * @param cycles - Output array of detected cycles
   */
  private dfs(
    node: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[],
    cycles: string[][]
  ): void {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const neighbors = this.graph.get(node) || [];

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        this.dfs(neighbor, visited, recursionStack, path, cycles);
      } else if (recursionStack.has(neighbor)) {
        // Found a cycle
        const cycleStartIndex = path.indexOf(neighbor);
        const cycle = path.slice(cycleStartIndex);
        cycle.push(neighbor); // Complete the cycle
        cycles.push(cycle);
      }
    }

    path.pop();
    recursionStack.delete(node);
  }

  /**
   * Get import order for a target library using topological sort
   *
   * Returns dependencies in correct order (dependencies before dependents)
   *
   * @param targetLib - Target library name
   * @returns Ordered array of library names to import
   */
  getImportOrder(targetLib: string): string[] {
    if (!this.graph.has(targetLib)) {
      return [targetLib];
    }

    // Use Kahn's algorithm for topological sort
    const inDegree = new Map<string, number>();
    const queue: string[] = [];
    const result: string[] = [];

    // Calculate in-degrees for subgraph reachable from target
    const reachable = this.getReachableNodes(targetLib);

    for (const node of reachable) {
      inDegree.set(node, 0);
    }

    for (const node of reachable) {
      const deps = this.graph.get(node) || [];
      for (const dep of deps) {
        if (reachable.has(dep)) {
          inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
        }
      }
    }

    // Find nodes with no incoming edges
    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }

    // Process queue
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) break;
      result.push(node);

      // In-degrees count incoming dependent→dependency edges, so releasing this node
      // decrements its own dependencies (forward graph), not its dependents.
      const deps = this.graph.get(node) || [];
      for (const dep of deps) {
        if (reachable.has(dep)) {
          const newDegree = (inDegree.get(dep) || 0) - 1;
          inDegree.set(dep, newDegree);

          if (newDegree === 0) {
            queue.push(dep);
          }
        }
      }
    }

    // Reverse to get dependencies-first order
    return result.reverse();
  }

  /**
   * Get all nodes reachable from a starting node
   *
   * @param start - Starting node
   * @returns Set of reachable node names
   */
  private getReachableNodes(start: string): Set<string> {
    const reachable = new Set<string>();
    const queue = [start];

    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined || reachable.has(node)) continue;

      reachable.add(node);

      const deps = this.graph.get(node) || [];
      for (const dep of deps) {
        if (!reachable.has(dep)) {
          queue.push(dep);
        }
      }
    }

    return reachable;
  }

  /**
   * Resolve all dependencies for a target library
   *
   * @param targetLib - Target library name
   * @returns Complete dependency resolution with order, cycles, and conflicts
   */
  resolve(targetLib: string): DependencyResolution {
    const cycles = this.detectCycles();
    const missing = this.findMissingDependencies(targetLib);
    const conflicts = this.findVersionConflicts(targetLib);

    let importOrder: string[] = [];
    if (cycles.length === 0) {
      importOrder = this.getImportOrder(targetLib);
    }

    return {
      importOrder,
      cycles,
      missing,
      conflicts,
    };
  }

  /**
   * Find missing dependencies for a target library
   *
   * @param targetLib - Target library name
   * @returns Array of missing dependency names
   */
  private findMissingDependencies(targetLib: string): string[] {
    const missing: string[] = [];
    const reachable = this.getReachableNodes(targetLib);

    for (const node of reachable) {
      const deps = this.graph.get(node) || [];
      for (const dep of deps) {
        if (!this.graph.has(dep) && !missing.includes(dep)) {
          missing.push(dep);
        }
      }
    }

    return missing;
  }

  /**
   * Find version conflicts in dependencies
   *
   * @param targetLib - Target library name
   * @returns Array of version conflicts
   */
  private findVersionConflicts(targetLib: string): VersionConflict[] {
    // Placeholder for version conflict detection
    // Will be enhanced when version constraints are added to dependencies
    return [];
  }

  /**
   * Resolve relative #Include path
   *
   * @param includePath - Path from #Include directive
   * @param fromLibraryPath - Path of library containing the #Include
   * @returns Resolved absolute path or library name
   */
  resolvePath(includePath: string, fromLibraryPath: string): string {
    // If path is in angle brackets, it's a library name
    if (includePath.startsWith('<') && includePath.endsWith('>')) {
      return includePath.slice(1, -1);
    }

    // If path is absolute, return as-is
    if (path.isAbsolute(includePath)) {
      return includePath;
    }

    // Resolve relative path from library's directory
    const libraryDir = path.dirname(fromLibraryPath);
    const resolvedPath = path.resolve(libraryDir, includePath);

    // Return library name (filename without extension)
    return path.basename(resolvedPath, '.ahk');
  }

  /**
   * Get all dependencies (direct and transitive) for a library
   *
   * @param libraryName - Library name
   * @returns Set of all dependency names
   */
  getAllDependencies(libraryName: string): Set<string> {
    const allDeps = new Set<string>();
    const queue = [libraryName];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const deps = this.graph.get(current) || [];

      for (const dep of deps) {
        if (!allDeps.has(dep)) {
          allDeps.add(dep);
          queue.push(dep);
        }
      }
    }

    return allDeps;
  }

  /**
   * Get all libraries that depend on a given library
   *
   * @param libraryName - Library name
   * @returns Array of dependent library names
   */
  getDependents(libraryName: string): string[] {
    return this.reverseGraph.get(libraryName) || [];
  }
}
