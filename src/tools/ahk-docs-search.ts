import { z } from 'zod';
import FlexSearch from 'flexsearch';
import { getAhkIndex, getAhkDocumentationFull } from '../core/loader.js';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';

export const AhkDocSearchArgsSchema = z.object({
  query: z.string().min(1).max(200).describe('Search query (1-200 characters, required)'),
  category: z
    .enum(['auto', 'functions', 'variables', 'classes', 'methods'])
    .optional()
    .default('auto')
    .describe('Restrict search category (default: auto)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of results to skip for pagination (default: 0)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum results to return per page (default: 10, max: 50)'),
});

export const ahkDocSearchToolDefinition = {
  name: 'AHK_Doc_Search',
  description: `Ahk doc search
Full-text search across AutoHotkey v2 docs using FlexSearch (functions, variables, classes, methods).`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Search query (1-200 characters)',
      },
      category: {
        type: 'string',
        enum: ['auto', 'functions', 'variables', 'classes', 'methods'],
        default: 'auto',
        description: 'Restrict search category',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Number of results to skip for pagination',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum results to return per page',
      },
    },
    required: ['query'],
  },
};

interface IndexedDoc {
  id: string;
  type: 'function' | 'variable' | 'class' | 'method';
  name: string;
  description?: string;
  path?: string;
}

export class AhkDocSearchTool {
  private static initialized = false;
  private static index = new FlexSearch.Document<IndexedDoc, true>({
    document: {
      id: 'id',
      index: ['name', 'description', 'path'],
      store: true,
    },
    tokenize: 'forward',
    cache: true,
    preset: 'match',
  } as any);

  private static corpus: IndexedDoc[] = [];

  private ensureIndex(): void {
    if (AhkDocSearchTool.initialized) return;

    const index = getAhkIndex();
    const full = getAhkDocumentationFull();
    const docs: IndexedDoc[] = [];

    if (index) {
      (index.functions || []).forEach((f: any, i: number) => {
        docs.push({
          id: `fn:${i}:${f.Name}`,
          type: 'function',
          name: f.Name,
          description: f.Description,
        });
      });
      (index.variables || []).forEach((v: any, i: number) => {
        docs.push({
          id: `var:${i}:${v.Name}`,
          type: 'variable',
          name: v.Name,
          description: v.Description,
        });
      });
      (index.classes || []).forEach((c: any, i: number) => {
        docs.push({
          id: `cls:${i}:${c.Name}`,
          type: 'class',
          name: c.Name,
          description: c.Description,
        });
      });
      (index.methods || []).forEach((m: any, i: number) => {
        const fullName = m.Path ? `${m.Path}.${m.Name}` : m.Name;
        docs.push({
          id: `meth:${i}:${fullName}`,
          type: 'method',
          name: fullName,
          description: m.Description,
          path: m.Path,
        });
      });
    }

    // Optionally enrich from full docs
    if (full?.data) {
      (full.data.Functions || []).slice(0, 10000).forEach((f: any, i: number) => {
        docs.push({
          id: `fdfn:${i}:${f.Name}`,
          type: 'function',
          name: f.Name,
          description: f.Description,
        });
      });
    }

    AhkDocSearchTool.corpus = docs;
    try {
      // FlexSearch.Document prefers adding items individually
      for (const d of docs) {
        (AhkDocSearchTool.index as any).add(d);
      }
      AhkDocSearchTool.initialized = true;
      logger.info(`FlexSearch doc index initialized with ${docs.length} items`);
    } catch (err) {
      logger.error('Failed to build FlexSearch index:', err);
      AhkDocSearchTool.initialized = true; // Avoid retry loops
    }
  }

  async execute(args: unknown): Promise<any> {
    const parsed = safeParse(args, AhkDocSearchArgsSchema, 'AHK_Doc_Search');
    if (!parsed.success) return parsed.error;

    try {
      const { query, category, offset = 0, limit = 10 } = parsed.data;
      this.ensureIndex();

      const filterType = (t: string) => {
        if (category === 'auto') return true;
        if (category === 'functions') return t === 'function';
        if (category === 'variables') return t === 'variable';
        if (category === 'classes') return t === 'class';
        if (category === 'methods') return t === 'method';
        return true;
      };

      let allResults: IndexedDoc[] = [];
      const maxToFetch = offset + limit + 20; // +20 to check for more
      try {
        const sets = await (AhkDocSearchTool.index as any).search(query, {
          enrich: true,
          limit: maxToFetch * 2,
          index: ['name', 'description', 'path'],
        });
        // Aggregate unique docs across fields
        const seen = new Set<string>();
        const aggregated: IndexedDoc[] = [];
        for (const set of sets || []) {
          for (const unit of set.result || []) {
            const doc: IndexedDoc | undefined = unit.doc as any;
            if (!doc) continue;
            if (!filterType(doc.type)) continue;
            if (seen.has(doc.id)) continue;
            seen.add(doc.id);
            aggregated.push(doc);
            if (aggregated.length >= maxToFetch) break;
          }
          if (aggregated.length >= maxToFetch) break;
        }
        allResults = aggregated;
      } catch (err) {
        logger.error('FlexSearch search error:', err);
        // fallback: linear scan
        allResults = AhkDocSearchTool.corpus
          .filter(
            d =>
              filterType(d.type) &&
              (d.name.toLowerCase().includes(query.toLowerCase()) ||
                (d.description || '').toLowerCase().includes(query.toLowerCase()))
          )
          .slice(0, maxToFetch);
      }

      // Apply pagination
      const totalCount = allResults.length;
      const results = allResults.slice(offset, offset + limit);
      const hasMore = totalCount > offset + limit;

      // Pagination metadata
      const paginationMeta = {
        offset,
        limit,
        returned: results.length,
        total: totalCount > offset + limit ? totalCount : offset + results.length,
        has_more: hasMore,
      };

      if (results.length === 0) {
        const message =
          offset > 0
            ? `No documentation matches for "${query}" (${category}) at offset ${offset}.`
            : `No documentation matches for "${query}" (${category}).`;
        return {
          content: [{ type: 'text', text: message }],
          _meta: { pagination: paginationMeta },
        };
      }

      const lines = results.map(d => {
        const kind = d.type[0].toUpperCase() + d.type.slice(1);
        const desc = d.description
          ? d.description.length > 180
            ? d.description.slice(0, 177) + '...'
            : d.description
          : '';
        const path = d.path ? ` [${d.path}]` : '';
        return `- ${kind}: ${d.name}${path}${desc ? `\n  ${desc}` : ''}`;
      });

      const header = `Results for "${query}" (${category})`;
      const pageInfo = hasMore
        ? ` - showing ${offset + 1}-${offset + results.length} of ${totalCount}+`
        : '';
      const footer = hasMore
        ? `\n\n*More results available. Use offset=${offset + limit} to see next page.*`
        : '';

      return {
        content: [{ type: 'text', text: `${header}${pageInfo}:\n\n${lines.join('\n')}${footer}` }],
        _meta: { pagination: paginationMeta },
      };
    } catch (error) {
      logger.error('Error in AHK_Doc_Search tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}
