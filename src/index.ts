#!/usr/bin/env node

/**
 * Freshdesk MCP Server
 * Provides MCP tools for interacting with the Freshdesk API
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FreshdeskClient,
  type CreateTicketParams,
  type UpdateContactParams,
  type CreateContactParams,
  type ReplyParams,
  type NoteParams,
  type ListTicketsParams,
  type CreateCompanyParams,
  type UpdateCompanyParams,
  type CreateTimeEntryParams,
} from './freshdesk-client.js';

// Get configuration from environment variables
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

if (!FRESHDESK_DOMAIN || !FRESHDESK_API_KEY) {
  console.error('Error: FRESHDESK_DOMAIN and FRESHDESK_API_KEY environment variables are required');
  process.exit(1);
}

const client = new FreshdeskClient({
  domain: FRESHDESK_DOMAIN,
  apiKey: FRESHDESK_API_KEY,
});

// Status and priority mappings
/** Os quatro primeiros sao os do Freshdesk padrao; de 6 em diante sao status que
 *  cada helpdesk cria por conta propria. Rode `list_ticket_fields` e olhe as
 *  `choices` do campo `status` para ver os do seu - os nomes abaixo sao os mais
 *  comuns, e um status desconhecido aparece como numero em vez de quebrar. */
const STATUS_MAP: Record<number, string> = {
  2: 'Open',
  3: 'Pending',
  4: 'Resolved',
  5: 'Closed',
  6: 'Esperando pelo cliente',
  7: 'Esperando por terceiros',
  8: 'Em atendimento',
  9: 'Aguardando N2',
  10: 'Responder ao cliente',
  11: 'Aguardando N1',
  12: 'Aguardando Negocios',
  9000: 'Assigned to AI Agent',
};

/** Valores aceitos onde o status entra como parametro. String porque o MCP
 *  transporta enum como texto. */
const STATUS_VALORES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '9000'] as const;

const PRIORITY_MAP: Record<number, string> = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

const SOURCE_MAP: Record<number, string> = {
  1: 'Email',
  2: 'Portal',
  3: 'Phone',
  7: 'Chat',
  9: 'Feedback Widget',
  10: 'Outbound Email',
};

// Helper formatters
/** Nome legivel de um agente ou contato. O Freshdesk devolve o nome do agente
 *  aninhado em `contact`, nao na raiz - por isso o fallback. */
function personLabel(p: Record<string, unknown> | undefined | null, id: unknown): string {
  if (!p) return String(id ?? 'N/A');
  const c = (p.contact as Record<string, unknown> | undefined) || p;
  const name = (c.name as string) || (p.name as string);
  const email = (c.email as string) || (p.email as string);
  if (!name && !email) return String(id ?? 'N/A');
  return `${name || '(sem nome)'}${email ? ` <${email}>` : ''}${id ? ` (id ${id})` : ''}`;
}

interface FormatTicketOptions {
  requester?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  agentNota?: string;
  includeHtml?: boolean;
}

function formatTicket(ticket: Record<string, unknown>, opts: FormatTicketOptions = {}): string {
  const status = STATUS_MAP[ticket.status as number] || ticket.status;
  const priority = PRIORITY_MAP[ticket.priority as number] || ticket.priority;
  const source = SOURCE_MAP[ticket.source as number] || ticket.source;

  const custom = ticket.custom_fields as Record<string, unknown> | undefined;
  const customLines =
    custom && Object.keys(custom).length > 0
      ? '\nCustom fields:\n' +
        Object.entries(custom)
          .map(([k, v]) => `  ${k}: ${v === null || v === undefined ? '(vazio)' : v}`)
          .join('\n')
      : '';

  const atts = ticket.attachments as Array<Record<string, unknown>> | undefined;
  const attLines =
    atts && atts.length > 0
      ? `\nAttachments (${atts.length}):\n` +
        atts.map((a) => `  [${a.id}] ${a.name} (${a.content_type}, ${a.size} bytes)`).join('\n') +
        '\n  use get_ticket_attachments para as URLs e download_ticket_attachment para baixar'
      : '';

  return `
Ticket #${ticket.id}
Subject: ${ticket.subject}
Status: ${status}
Priority: ${priority}
Source: ${source}
Requester: ${personLabel(opts.requester ?? (ticket.requester as Record<string, unknown>), ticket.requester_id)}
${ticket.responder_id ? `Assigned Agent: ${personLabel(opts.agent, ticket.responder_id)}${opts.agentNota || ''}` : 'Unassigned'}
${ticket.group_id ? `Group ID: ${ticket.group_id}` : ''}
Created: ${ticket.created_at}
Updated: ${ticket.updated_at}
${ticket.tags && (ticket.tags as string[]).length > 0 ? `Tags: ${(ticket.tags as string[]).join(', ')}` : ''}${customLines}${attLines}
${ticket.description_text ? `\nDescription:\n${ticket.description_text}` : ''}
${opts.includeHtml && ticket.description ? `\nDescription (HTML - contem as imagens inline):\n${ticket.description}` : ''}
`.trim();
}

function formatContact(contact: Record<string, unknown>): string {
  return `
Contact #${contact.id}
Name: ${contact.name}
Email: ${contact.email || 'N/A'}
Phone: ${contact.phone || 'N/A'}
Mobile: ${contact.mobile || 'N/A'}
Company ID: ${contact.company_id || 'N/A'}
Job Title: ${contact.job_title || 'N/A'}
Active: ${contact.active}
Created: ${contact.created_at}
${contact.tags && (contact.tags as string[]).length > 0 ? `Tags: ${(contact.tags as string[]).join(', ')}` : ''}
${contact.description ? `\nDescription:\n${contact.description}` : ''}
`.trim();
}

/** Dados pessoais do agente (nome, e-mail, telefone, cargo, ativo) vem dentro de
 *  `contact`, nao na raiz - mesmo motivo do fallback em personLabel. Ja `id`,
 *  `available` e `group_ids` ficam na raiz e nao passam por aqui. */
function agentPessoa(agent: Record<string, unknown>): Record<string, unknown> {
  const c = (agent.contact as Record<string, unknown> | undefined) || {};
  const pega = (k: string) => c[k] ?? agent[k];
  return {
    name: pega('name'),
    email: pega('email'),
    phone: pega('phone'),
    mobile: pega('mobile'),
    active: pega('active'),
    job_title: pega('job_title'),
  };
}

function formatAgent(agent: Record<string, unknown>): string {
  const p = agentPessoa(agent);
  return `
Agent #${agent.id}
Name: ${p.name || 'N/A'}
Email: ${p.email || 'N/A'}
Phone: ${p.phone || p.mobile || 'N/A'}
Active: ${p.active}
Available: ${agent.available}
Job Title: ${p.job_title || 'N/A'}
Groups: ${(agent.group_ids as number[])?.join(', ') || 'None'}
Created: ${agent.created_at}
`.trim();
}

function formatGroup(group: Record<string, unknown>): string {
  return `
Group #${group.id}
Name: ${group.name}
Description: ${group.description || 'N/A'}
Agent IDs: ${(group.agent_ids as number[])?.join(', ') || 'None'}
Created: ${group.created_at}
`.trim();
}

function formatCompany(company: Record<string, unknown>): string {
  return `
Company #${company.id}
Name: ${company.name}
Description: ${company.description || 'N/A'}
Domains: ${(company.domains as string[])?.join(', ') || 'N/A'}
Industry: ${company.industry || 'N/A'}
Health Score: ${company.health_score || 'N/A'}
Created: ${company.created_at}
`.trim();
}

function formatConversation(conv: Record<string, unknown>): string {
  const type = conv.private ? 'Private Note' : (conv.incoming ? 'Customer Reply' : 'Agent Reply');
  return `
[${type}] ID: ${conv.id}
From User ID: ${conv.user_id}
Created: ${conv.created_at}
${conv.body_text || conv.body}
---`;
}

function formatTimeEntry(entry: Record<string, unknown>): string {
  return `
Time Entry #${entry.id}
Agent ID: ${entry.agent_id}
Time Spent: ${entry.time_spent}
Billable: ${entry.billable}
Timer Running: ${entry.timer_running}
Note: ${entry.note || 'N/A'}
Executed At: ${entry.executed_at}
`.trim();
}

// Create MCP server
const server = new McpServer({
  name: 'freshdesk-mcp-server',
  version: '1.0.0',
});

// ==================== PHASE 1: CORE TICKET OPERATIONS ====================

// 1. List Tickets
server.tool(
  'list_tickets',
  'List all tickets from Freshdesk with optional filters.',
  {
    filter: z.enum(['new_and_my_open', 'watching', 'spam', 'deleted']).optional()
      .describe('Predefined filter'),
    requester_id: z.number().optional().describe('Filter by requester ID'),
    email: z.string().optional().describe('Filter by requester email'),
    company_id: z.number().optional().describe('Filter by company ID'),
    updated_since: z.string().optional().describe('Filter by update date (ISO format)'),
    order_by: z.enum(['created_at', 'due_by', 'updated_at', 'status']).optional(),
    order_type: z.enum(['asc', 'desc']).optional(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async (params) => {
    try {
      const tickets = await client.listTickets(params as ListTicketsParams);
      if (tickets.length === 0) {
        return { content: [{ type: 'text', text: 'No tickets found.' }] };
      }
      const summary = tickets.map((t) => {
        const status = STATUS_MAP[t.status] || t.status;
        const priority = PRIORITY_MAP[t.priority] || t.priority;
        return `#${t.id} | ${status} | ${priority} | ${t.subject}`;
      }).join('\n');
      return { content: [{ type: 'text', text: `Found ${tickets.length} ticket(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 2. View Ticket
server.tool(
  'view_ticket',
  'View detailed information about a specific ticket. Resolve os nomes do solicitante e do agente responsavel, e mostra os campos customizados. Use include_html quando o texto vier truncado ou fizer referencia a algo "abaixo": as imagens do chamado sao inline no HTML e somem na versao em texto.',
  {
    ticket_id: z.number().describe('The ticket ID'),
    include: z.array(z.enum(['conversations', 'requester', 'company', 'stats'])).optional(),
    include_html: z
      .boolean()
      .optional()
      .describe('Inclui a description em HTML, onde ficam as tags <img> das imagens coladas no chamado'),
    resolve_names: z
      .boolean()
      .optional()
      .default(true)
      .describe('Busca os nomes do solicitante e do agente responsavel em vez de mostrar so os IDs'),
  },
  async ({ ticket_id, include, include_html, resolve_names }) => {
    try {
      // O solicitante vem de graca pelo proprio include da API - e o unico
      // caminho que funciona com conta de permissao restrita. viewContact da 404
      // quando o solicitante e um agente, e viewAgent da 403 sem permissao.
      const includes = new Set(include || []);
      if (resolve_names !== false) includes.add('requester');

      const ticket = (await client.viewTicket(
        ticket_id,
        includes.size > 0 ? (Array.from(includes) as Array<'conversations' | 'requester' | 'company' | 'stats'>) : undefined
      )) as unknown as Record<string, unknown>;

      const requester = (ticket.requester as Record<string, unknown>) || null;
      let agent: Record<string, unknown> | null = null;
      let agentNota = '';

      if (resolve_names !== false && ticket.responder_id) {
        try {
          agent = (await client.viewAgent(ticket.responder_id as number)) as unknown as Record<string, unknown>;
        } catch {
          // 403 e o normal com permissao restrita. Se o responsavel for a propria
          // conta, /agents/me resolve sem precisar de permissao sobre outros.
          try {
            const eu = (await client.getCurrentAgent()) as unknown as Record<string, unknown>;
            if (eu && eu.id === ticket.responder_id) {
              agent = eu;
              agentNota = ' — voce';
            } else {
              agentNota = ' — sem permissao para resolver o nome';
            }
          } catch {
            agentNota = ' — sem permissao para resolver o nome';
          }
        }
      }

      return {
        content: [
          { type: 'text', text: formatTicket(ticket, { requester, agent, agentNota, includeHtml: include_html }) },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 3. Create Ticket
server.tool(
  'create_ticket',
  'Create a new support ticket. Requires subject, description, and email or requester_id.',
  {
    subject: z.string().describe('Ticket subject'),
    description: z.string().describe('HTML description'),
    email: z.string().optional().describe('Requester email'),
    requester_id: z.number().optional().describe('Existing requester ID'),
    priority: z.enum(['1', '2', '3', '4']).optional().describe('1=Low, 2=Medium, 3=High, 4=Urgent'),
    status: z.enum(STATUS_VALORES).optional().describe('2=Open, 3=Pending, 4=Resolved, 5=Closed. De 6 em diante sao status customizados do helpdesk - rode list_ticket_fields para ver os do seu'),
    type: z.string().optional().describe('Ticket type'),
    group_id: z.number().optional(),
    responder_id: z.number().optional(),
    tags: z.array(z.string()).optional(),
  },
  async (params) => {
    try {
      if (!params.email && !params.requester_id) {
        return { content: [{ type: 'text', text: 'Error: email or requester_id required.' }], isError: true };
      }
      const createParams: CreateTicketParams = {
        subject: params.subject,
        description: params.description,
        email: params.email,
        requester_id: params.requester_id,
        priority: params.priority ? parseInt(params.priority) as 1 | 2 | 3 | 4 : undefined,
        status: params.status ? parseInt(params.status) : undefined,
        type: params.type,
        group_id: params.group_id,
        responder_id: params.responder_id,
        tags: params.tags,
      };
      const ticket = await client.createTicket(createParams);
      return { content: [{ type: 'text', text: `Ticket created!\n\n${formatTicket(ticket as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 4. Search Tickets
server.tool(
  'search_tickets',
  'Search tickets using Freshdesk query syntax.',
  {
    query: z.string().describe('Query: "status:2", "priority:4", "(status:2 OR status:3) AND priority:4"'),
  },
  async ({ query }) => {
    try {
      const result = await client.searchTickets(query);
      if (result.results.length === 0) {
        return { content: [{ type: 'text', text: `No tickets found for: ${query}` }] };
      }
      const summary = result.results.map((t) => {
        const status = STATUS_MAP[t.status] || t.status;
        const priority = PRIORITY_MAP[t.priority] || t.priority;
        return `#${t.id} | ${status} | ${priority} | ${t.subject}`;
      }).join('\n');
      return { content: [{ type: 'text', text: `Found ${result.total} ticket(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 5. Update Ticket
server.tool(
  'update_ticket',
  'Update a ticket (status, priority, assignee, etc.).',
  {
    ticket_id: z.number().describe('Ticket ID'),
    subject: z.string().optional(),
    description: z.string().optional(),
    priority: z.enum(['1', '2', '3', '4']).optional(),
    status: z.enum(STATUS_VALORES).optional().describe('2=Open, 3=Pending, 4=Resolved, 5=Closed, e os customizados do helpdesk de 6 em diante'),
    type: z.string().optional(),
    group_id: z.number().optional(),
    responder_id: z.number().optional(),
    tags: z.array(z.string()).optional(),
    custom_fields: z
      .record(z.any())
      .optional()
      .describe(
        'Campos customizados do helpdesk, com o prefixo cf_. Muitas contas exigem campos obrigatorios para mudar o status - se o update falhar com "Validation failed / missing_field", a mensagem de erro diz quais faltam. Ex: {"cf_prazo_estimado_n2":"2026-08-19","cf_prazo_estimado_n2_em_horas":4}'
      ),
  },
  async ({ ticket_id, ...params }) => {
    try {
      const updateParams: Partial<CreateTicketParams> = {};
      if (params.subject) updateParams.subject = params.subject;
      if (params.description) updateParams.description = params.description;
      if (params.priority) updateParams.priority = parseInt(params.priority) as 1 | 2 | 3 | 4;
      if (params.status) updateParams.status = parseInt(params.status);
      if (params.type) updateParams.type = params.type;
      if (params.group_id) updateParams.group_id = params.group_id;
      if (params.responder_id) updateParams.responder_id = params.responder_id;
      if (params.tags) updateParams.tags = params.tags;
      if (params.custom_fields) updateParams.custom_fields = params.custom_fields;

      const ticket = await client.updateTicket(ticket_id, updateParams);
      return { content: [{ type: 'text', text: `Ticket updated!\n\n${formatTicket(ticket as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 6. Reply to Ticket
server.tool(
  'reply_to_ticket',
  'Send a public reply to a ticket (emails the customer).',
  {
    ticket_id: z.number().describe('Ticket ID'),
    body: z.string().describe('HTML reply body'),
    cc_emails: z.array(z.string()).optional(),
    bcc_emails: z.array(z.string()).optional(),
  },
  async ({ ticket_id, body, cc_emails, bcc_emails }) => {
    try {
      const replyParams: ReplyParams = { body };
      if (cc_emails) replyParams.cc_emails = cc_emails;
      if (bcc_emails) replyParams.bcc_emails = bcc_emails;
      const conv = await client.replyToTicket(ticket_id, replyParams);
      return { content: [{ type: 'text', text: `Reply sent to ticket #${ticket_id}!\nConversation ID: ${conv.id}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 7. Add Note to Ticket
server.tool(
  'add_note_to_ticket',
  'Add a note to a ticket (private or public).',
  {
    ticket_id: z.number().describe('Ticket ID'),
    body: z.string().describe('HTML note body'),
    private: z.boolean().optional().default(true).describe('Private note (default true)'),
    notify_emails: z.array(z.string()).optional(),
  },
  async ({ ticket_id, body, private: isPrivate, notify_emails }) => {
    try {
      const noteParams: NoteParams = { body, private: isPrivate ?? true };
      if (notify_emails) noteParams.notify_emails = notify_emails;
      const conv = await client.addNote(ticket_id, noteParams);
      return { content: [{ type: 'text', text: `Note added to ticket #${ticket_id}!\nNote ID: ${conv.id}, Private: ${conv.private}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 8. View Contact
server.tool(
  'view_contact',
  'View detailed information about a contact.',
  {
    contact_id: z.number().describe('Contact ID'),
  },
  async ({ contact_id }) => {
    try {
      const contact = await client.viewContact(contact_id);
      return { content: [{ type: 'text', text: formatContact(contact as unknown as Record<string, unknown>) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 9. Update Contact
server.tool(
  'update_contact',
  'Update a contact\'s information.',
  {
    contact_id: z.number().describe('Contact ID'),
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    mobile: z.string().optional(),
    address: z.string().optional(),
    description: z.string().optional(),
    job_title: z.string().optional(),
    company_id: z.number().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ contact_id, ...params }) => {
    try {
      const updateParams: UpdateContactParams = {};
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) (updateParams as Record<string, unknown>)[key] = value;
      });
      const contact = await client.updateContact(contact_id, updateParams);
      return { content: [{ type: 'text', text: `Contact updated!\n\n${formatContact(contact as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ==================== PHASE 2: ENHANCED SUPPORT ====================

// 10. List Ticket Conversations
server.tool(
  'list_ticket_conversations',
  'Get all conversations (replies and notes) for a ticket.',
  {
    ticket_id: z.number().describe('Ticket ID'),
  },
  async ({ ticket_id }) => {
    try {
      const conversations = await client.listConversations(ticket_id);
      if (conversations.length === 0) {
        return { content: [{ type: 'text', text: `No conversations found for ticket #${ticket_id}` }] };
      }
      const formatted = conversations.map(c => formatConversation(c as unknown as Record<string, unknown>)).join('\n');
      return { content: [{ type: 'text', text: `Conversations for ticket #${ticket_id}:\n\n${formatted}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 11. List Contacts
server.tool(
  'list_contacts',
  'List all contacts with optional filters.',
  {
    email: z.string().optional().describe('Filter by email'),
    phone: z.string().optional().describe('Filter by phone'),
    company_id: z.number().optional().describe('Filter by company'),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async (params) => {
    try {
      const contacts = await client.listContacts(params);
      if (contacts.length === 0) {
        return { content: [{ type: 'text', text: 'No contacts found.' }] };
      }
      const summary = contacts.map(c => `#${c.id} | ${c.name} | ${c.email || 'N/A'} | ${c.phone || 'N/A'}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${contacts.length} contact(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 12. Search Contacts
server.tool(
  'search_contacts',
  'Search contacts using query syntax.',
  {
    query: z.string().describe('Query: "email:john@example.com", "name:John"'),
  },
  async ({ query }) => {
    try {
      const result = await client.searchContacts(query);
      if (result.results.length === 0) {
        return { content: [{ type: 'text', text: `No contacts found for: ${query}` }] };
      }
      const summary = result.results.map(c => `#${c.id} | ${c.name} | ${c.email || 'N/A'}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${result.total} contact(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 13. Create Contact
server.tool(
  'create_contact',
  'Create a new contact.',
  {
    name: z.string().describe('Contact name'),
    email: z.string().optional(),
    phone: z.string().optional(),
    mobile: z.string().optional(),
    address: z.string().optional(),
    description: z.string().optional(),
    job_title: z.string().optional(),
    company_id: z.number().optional(),
    tags: z.array(z.string()).optional(),
  },
  async (params) => {
    try {
      const createParams: CreateContactParams = {
        name: params.name,
        email: params.email,
        phone: params.phone,
        mobile: params.mobile,
        address: params.address,
        description: params.description,
        job_title: params.job_title,
        company_id: params.company_id,
        tags: params.tags,
      };
      const contact = await client.createContact(createParams);
      return { content: [{ type: 'text', text: `Contact created!\n\n${formatContact(contact as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 14. List Agents
server.tool(
  'list_agents',
  'List all agents.',
  {
    email: z.string().optional().describe('Filter by email'),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async (params) => {
    try {
      const agents = await client.listAgents(params);
      if (agents.length === 0) {
        return { content: [{ type: 'text', text: 'No agents found.' }] };
      }
      const summary = agents.map(a => {
        const p = agentPessoa(a as unknown as Record<string, unknown>);
        return `#${a.id} | ${p.name || 'N/A'} | ${p.email || 'N/A'} | Active: ${p.active} | Available: ${a.available}`;
      }).join('\n');
      return { content: [{ type: 'text', text: `Found ${agents.length} agent(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 15. View Agent
server.tool(
  'view_agent',
  'View detailed information about an agent.',
  {
    agent_id: z.number().describe('Agent ID'),
  },
  async ({ agent_id }) => {
    try {
      const agent = await client.viewAgent(agent_id);
      return { content: [{ type: 'text', text: formatAgent(agent as unknown as Record<string, unknown>) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 16. Get Current Agent
server.tool(
  'get_current_agent',
  'Get the currently authenticated agent.',
  {},
  async () => {
    try {
      const agent = await client.getCurrentAgent();
      return { content: [{ type: 'text', text: formatAgent(agent as unknown as Record<string, unknown>) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 17. List Groups
server.tool(
  'list_groups',
  'List all agent groups.',
  {},
  async () => {
    try {
      const groups = await client.listGroups();
      if (groups.length === 0) {
        return { content: [{ type: 'text', text: 'No groups found.' }] };
      }
      const summary = groups.map(g => `#${g.id} | ${g.name} | ${g.description || 'No description'}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${groups.length} group(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 18. View Group
server.tool(
  'view_group',
  'View detailed information about a group.',
  {
    group_id: z.number().describe('Group ID'),
  },
  async ({ group_id }) => {
    try {
      const group = await client.viewGroup(group_id);
      return { content: [{ type: 'text', text: formatGroup(group as unknown as Record<string, unknown>) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ==================== PHASE 3: POWER FEATURES ====================

// 19. List Companies
server.tool(
  'list_companies',
  'List all companies.',
  {
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async (params) => {
    try {
      const companies = await client.listCompanies(params);
      if (companies.length === 0) {
        return { content: [{ type: 'text', text: 'No companies found.' }] };
      }
      const summary = companies.map(c => `#${c.id} | ${c.name} | ${c.domains?.join(', ') || 'No domains'}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${companies.length} company(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 20. View Company
server.tool(
  'view_company',
  'View detailed information about a company.',
  {
    company_id: z.number().describe('Company ID'),
  },
  async ({ company_id }) => {
    try {
      const company = await client.viewCompany(company_id);
      return { content: [{ type: 'text', text: formatCompany(company as unknown as Record<string, unknown>) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 21. Create Company
server.tool(
  'create_company',
  'Create a new company.',
  {
    name: z.string().describe('Company name'),
    description: z.string().optional(),
    domains: z.array(z.string()).optional().describe('Company domains'),
    industry: z.string().optional(),
    health_score: z.string().optional(),
    account_tier: z.string().optional(),
    note: z.string().optional(),
  },
  async (params) => {
    try {
      const createParams: CreateCompanyParams = {
        name: params.name,
        description: params.description,
        domains: params.domains,
        industry: params.industry,
        health_score: params.health_score,
        account_tier: params.account_tier,
        note: params.note,
      };
      const company = await client.createCompany(createParams);
      return { content: [{ type: 'text', text: `Company created!\n\n${formatCompany(company as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 22. Update Company
server.tool(
  'update_company',
  'Update a company\'s information.',
  {
    company_id: z.number().describe('Company ID'),
    name: z.string().optional(),
    description: z.string().optional(),
    domains: z.array(z.string()).optional(),
    industry: z.string().optional(),
    health_score: z.string().optional(),
    account_tier: z.string().optional(),
    note: z.string().optional(),
  },
  async ({ company_id, ...params }) => {
    try {
      const updateParams: UpdateCompanyParams = {};
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) (updateParams as Record<string, unknown>)[key] = value;
      });
      const company = await client.updateCompany(company_id, updateParams);
      return { content: [{ type: 'text', text: `Company updated!\n\n${formatCompany(company as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 23. Search Companies
server.tool(
  'search_companies',
  'Search companies using query syntax.',
  {
    query: z.string().describe('Query: "name:Acme", "domain:acme.com"'),
  },
  async ({ query }) => {
    try {
      const result = await client.searchCompanies(query);
      if (result.results.length === 0) {
        return { content: [{ type: 'text', text: `No companies found for: ${query}` }] };
      }
      const summary = result.results.map(c => `#${c.id} | ${c.name}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${result.total} company(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 24. List Time Entries
server.tool(
  'list_time_entries',
  'List all time entries for a ticket.',
  {
    ticket_id: z.number().describe('Ticket ID'),
  },
  async ({ ticket_id }) => {
    try {
      const entries = await client.listTimeEntries(ticket_id);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: `No time entries for ticket #${ticket_id}` }] };
      }
      const formatted = entries.map(e => formatTimeEntry(e as unknown as Record<string, unknown>)).join('\n\n');
      return { content: [{ type: 'text', text: `Time entries for ticket #${ticket_id}:\n\n${formatted}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 25. Create Time Entry
server.tool(
  'create_time_entry',
  'Log time on a ticket.',
  {
    ticket_id: z.number().describe('Ticket ID'),
    time_spent: z.string().describe('Time spent in "hh:mm" format'),
    agent_id: z.number().optional().describe('Agent ID (defaults to current)'),
    billable: z.boolean().optional().describe('Is billable'),
    note: z.string().optional().describe('Note about the work'),
    executed_at: z.string().optional().describe('When work was done (ISO format)'),
  },
  async ({ ticket_id, ...params }) => {
    try {
      const createParams: CreateTimeEntryParams = { time_spent: params.time_spent };
      if (params.agent_id) createParams.agent_id = params.agent_id;
      if (params.billable !== undefined) createParams.billable = params.billable;
      if (params.note) createParams.note = params.note;
      if (params.executed_at) createParams.executed_at = params.executed_at;

      const entry = await client.createTimeEntry(ticket_id, createParams);
      return { content: [{ type: 'text', text: `Time entry created!\n\n${formatTimeEntry(entry as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 26. Toggle Timer
server.tool(
  'toggle_timer',
  'Start or stop a timer on a time entry.',
  {
    time_entry_id: z.number().describe('Time entry ID'),
  },
  async ({ time_entry_id }) => {
    try {
      const entry = await client.toggleTimer(time_entry_id);
      const status = entry.timer_running ? 'started' : 'stopped';
      return { content: [{ type: 'text', text: `Timer ${status}!\n\n${formatTimeEntry(entry as unknown as Record<string, unknown>)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 27. List Canned Response Folders
server.tool(
  'list_canned_response_folders',
  'List all canned response folders.',
  {},
  async () => {
    try {
      const folders = await client.listCannedResponseFolders();
      if (folders.length === 0) {
        return { content: [{ type: 'text', text: 'No canned response folders found.' }] };
      }
      const summary = folders.map(f => `#${f.id} | ${f.name} | ${f.responses_count || 0} responses`).join('\n');
      return { content: [{ type: 'text', text: `Found ${folders.length} folder(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 28. List Canned Responses
server.tool(
  'list_canned_responses',
  'List canned responses in a folder.',
  {
    folder_id: z.number().describe('Folder ID'),
  },
  async ({ folder_id }) => {
    try {
      const responses = await client.listCannedResponses(folder_id);
      if (responses.length === 0) {
        return { content: [{ type: 'text', text: 'No canned responses in this folder.' }] };
      }
      const summary = responses.map(r => `#${r.id} | ${r.title}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${responses.length} response(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 29. View Canned Response
server.tool(
  'view_canned_response',
  'View a canned response\'s content.',
  {
    response_id: z.number().describe('Response ID'),
  },
  async ({ response_id }) => {
    try {
      const response = await client.viewCannedResponse(response_id);
      return { content: [{ type: 'text', text: `Canned Response #${response.id}\nTitle: ${response.title}\n\nContent:\n${response.content}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 30. List Solution Categories
server.tool(
  'list_solution_categories',
  'List knowledge base categories.',
  {},
  async () => {
    try {
      const categories = await client.listSolutionCategories();
      if (categories.length === 0) {
        return { content: [{ type: 'text', text: 'No solution categories found.' }] };
      }
      const summary = categories.map(c => `#${c.id} | ${c.name} | ${c.description || 'No description'}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${categories.length} category(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 31. List Solution Folders
server.tool(
  'list_solution_folders',
  'List folders in a knowledge base category.',
  {
    category_id: z.number().describe('Category ID'),
  },
  async ({ category_id }) => {
    try {
      const folders = await client.listSolutionFolders(category_id);
      if (folders.length === 0) {
        return { content: [{ type: 'text', text: 'No folders in this category.' }] };
      }
      const summary = folders.map(f => `#${f.id} | ${f.name}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${folders.length} folder(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 32. List Solution Articles
server.tool(
  'list_solution_articles',
  'List articles in a knowledge base folder.',
  {
    folder_id: z.number().describe('Folder ID'),
  },
  async ({ folder_id }) => {
    try {
      const articles = await client.listSolutionArticles(folder_id);
      if (articles.length === 0) {
        return { content: [{ type: 'text', text: 'No articles in this folder.' }] };
      }
      const summary = articles.map(a => `#${a.id} | ${a.title} | 👍${a.thumbs_up} 👎${a.thumbs_down} | Views: ${a.hits}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${articles.length} article(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 33. View Solution Article
server.tool(
  'view_solution_article',
  'View a knowledge base article.',
  {
    article_id: z.number().describe('Article ID'),
  },
  async ({ article_id }) => {
    try {
      const article = await client.viewSolutionArticle(article_id);
      return { content: [{ type: 'text', text: `Article #${article.id}\nTitle: ${article.title}\nViews: ${article.hits} | 👍${article.thumbs_up} 👎${article.thumbs_down}\nTags: ${article.tags?.join(', ') || 'None'}\n\n${article.description_text || article.description}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 34. Search Solutions
server.tool(
  'search_solutions',
  'Search knowledge base articles.',
  {
    query: z.string().describe('Search term'),
  },
  async ({ query }) => {
    try {
      const articles = await client.searchSolutions(query);
      if (articles.length === 0) {
        return { content: [{ type: 'text', text: `No articles found for: ${query}` }] };
      }
      const summary = articles.map(a => `#${a.id} | ${a.title}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${articles.length} article(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 35. List Satisfaction Ratings (for ticket)
server.tool(
  'list_ticket_satisfaction_ratings',
  'List satisfaction ratings for a ticket.',
  {
    ticket_id: z.number().describe('Ticket ID'),
  },
  async ({ ticket_id }) => {
    try {
      const ratings = await client.listSatisfactionRatings(ticket_id);
      if (ratings.length === 0) {
        return { content: [{ type: 'text', text: `No satisfaction ratings for ticket #${ticket_id}` }] };
      }
      const summary = ratings.map(r => `#${r.id} | Rating: ${JSON.stringify(r.ratings)} | Feedback: ${r.feedback || 'None'}`).join('\n');
      return { content: [{ type: 'text', text: `Satisfaction ratings for ticket #${ticket_id}:\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 36. List All Satisfaction Ratings
server.tool(
  'list_all_satisfaction_ratings',
  'List all satisfaction ratings across tickets.',
  {
    created_since: z.string().optional().describe('Filter by date (ISO format)'),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async (params) => {
    try {
      const ratings = await client.viewAllSatisfactionRatings(params);
      if (ratings.length === 0) {
        return { content: [{ type: 'text', text: 'No satisfaction ratings found.' }] };
      }
      const summary = ratings.map(r => `Ticket #${r.ticket_id} | Rating: ${JSON.stringify(r.ratings)} | ${r.created_at}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${ratings.length} rating(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 37. List Ticket Fields
server.tool(
  'list_ticket_fields',
  'List all custom ticket fields.',
  {},
  async () => {
    try {
      const fields = await client.listTicketFields();
      if (fields.length === 0) {
        return { content: [{ type: 'text', text: 'No ticket fields found.' }] };
      }
      const summary = fields.map(f => `#${f.id} | ${f.name} | ${f.label} | Type: ${f.type} | Required: ${f.required_for_agents}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${fields.length} field(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 38. List Products
server.tool(
  'list_products',
  'List all products.',
  {},
  async () => {
    try {
      const products = await client.listProducts();
      if (products.length === 0) {
        return { content: [{ type: 'text', text: 'No products found.' }] };
      }
      const summary = products.map(p => `#${p.id} | ${p.name} | ${p.description || 'No description'}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${products.length} product(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 39. List Business Hours
server.tool(
  'list_business_hours',
  'List all business hour configurations.',
  {},
  async () => {
    try {
      const hours = await client.listBusinessHours();
      if (hours.length === 0) {
        return { content: [{ type: 'text', text: 'No business hours found.' }] };
      }
      const summary = hours.map(h => `#${h.id} | ${h.name} | Timezone: ${h.time_zone} | Default: ${h.is_default}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${hours.length} business hour config(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 40. List SLA Policies
server.tool(
  'list_sla_policies',
  'List all SLA policies.',
  {},
  async () => {
    try {
      const policies = await client.listSLAPolicies();
      if (policies.length === 0) {
        return { content: [{ type: 'text', text: 'No SLA policies found.' }] };
      }
      const summary = policies.map(p => `#${p.id} | ${p.name} | Default: ${p.is_default} | ${p.description || ''}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${policies.length} SLA policy(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// 41. List Roles
server.tool(
  'list_roles',
  'List all agent roles.',
  {},
  async () => {
    try {
      const roles = await client.listRoles();
      if (roles.length === 0) {
        return { content: [{ type: 'text', text: 'No roles found.' }] };
      }
      const summary = roles.map(r => `#${r.id} | ${r.name} | Default: ${r.default} | ${r.description || ''}`).join('\n');
      return { content: [{ type: 'text', text: `Found ${roles.length} role(s):\n\n${summary}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ==================== ATTACHMENTS ====================

/** Extrai as URLs de <img src="..."> de um trecho de HTML. */
function extractInlineImages(html: string | undefined | null): string[] {
  if (!html) return [];
  const urls: string[] = [];
  const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!m[1].startsWith('data:')) urls.push(m[1]);
  }
  return urls;
}

server.tool(
  'get_ticket_attachments',
  'Lista tudo que da para baixar de um chamado: anexos formais e as imagens coladas no corpo do e-mail (inline no HTML), incluindo as das conversas. Use quando o chamado mencionar print, imagem ou "conforme abaixo" e o texto vier truncado.',
  {
    ticket_id: z.number().describe('The ticket ID'),
    include_conversations: z
      .boolean()
      .optional()
      .default(true)
      .describe('Procura tambem nas respostas e notas do chamado'),
  },
  async ({ ticket_id, include_conversations }) => {
    try {
      const ticket = (await client.viewTicket(ticket_id)) as unknown as Record<string, unknown>;
      const linhas: string[] = [];
      let n = 0;

      const formais = (ticket.attachments as Array<Record<string, unknown>>) || [];
      for (const a of formais) {
        n++;
        linhas.push(
          `[${n}] ANEXO  ${a.name}\n     tipo: ${a.content_type} | ${a.size} bytes\n     url: ${a.attachment_url}`
        );
      }

      for (const url of extractInlineImages(ticket.description as string)) {
        n++;
        linhas.push(`[${n}] INLINE (descricao do chamado)\n     url: ${url}`);
      }

      if (include_conversations !== false) {
        const convs = (await client.listConversations(ticket_id)) as unknown as Array<Record<string, unknown>>;
        for (const c of convs) {
          const cAtts = (c.attachments as Array<Record<string, unknown>>) || [];
          for (const a of cAtts) {
            n++;
            linhas.push(
              `[${n}] ANEXO em conversa ${c.id}  ${a.name}\n     tipo: ${a.content_type} | ${a.size} bytes\n     url: ${a.attachment_url}`
            );
          }
          for (const url of extractInlineImages(c.body as string)) {
            n++;
            linhas.push(`[${n}] INLINE (conversa ${c.id})\n     url: ${url}`);
          }
        }
      }

      if (n === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Nenhum anexo ou imagem inline no chamado #${ticket_id}.\n\nSe voce esperava encontrar algo, confira o chamado na interface: imagem colada como conteudo de e-mail as vezes fica em uma conversa, nao na descricao.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `${n} item(ns) no chamado #${ticket_id}:\n\n${linhas.join('\n\n')}\n\nPara baixar: download_ticket_attachment com a url acima.`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

server.tool(
  'download_ticket_attachment',
  'Baixa um anexo ou imagem de chamado e salva em arquivo local, para que a imagem possa ser aberta e lida. Use a url devolvida por get_ticket_attachments.',
  {
    url: z.string().describe('URL do anexo ou da imagem, vinda de get_ticket_attachments'),
    out_path: z
      .string()
      .describe('Caminho completo do arquivo de saida, incluindo a extensao. Ex: C:/temp/print-chamado-61726.png'),
  },
  async ({ url, out_path }) => {
    try {
      const { buffer, contentType } = await client.downloadAttachment(url);

      const dir = path.dirname(out_path);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(out_path, buffer);

      return {
        content: [
          {
            type: 'text',
            text: `Salvo em ${out_path}\n  tipo: ${contentType}\n  tamanho: ${buffer.length} bytes\n\nAbra o arquivo para ver o conteudo.`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ==================== RELATORIOS / GESTAO ====================

/** "Aberto" e tudo que nao foi Resolved nem Closed. Contar so Open+Pending
 *  esconde os status customizados - num helpdesk real e ali que mora o trabalho
 *  em curso ("Em atendimento", "Aguardando N2"). */
const TODOS_STATUS = Object.keys(STATUS_MAP).map(Number).sort((a, b) => a - b);
const STATUS_ABERTOS = TODOS_STATUS.filter((s) => s !== 4 && s !== 5);

/** Filtro de busca para "em aberto", como um OR unico - uma query em vez de N. */
function filtroAbertos(): string {
  return `(${STATUS_ABERTOS.map((s) => `status:${s}`).join(' OR ')})`;
}

/** Conta sem paginar: o `total` do search ja vem completo na primeira pagina. */
async function contar(query: string): Promise<number> {
  const r = await client.searchTickets(query);
  return r.total ?? 0;
}

/** Coleta ate `maxPaginas` do search (30 por pagina). Avisa se truncou. */
async function coletar(
  query: string,
  maxPaginas = 10
): Promise<{ tickets: Array<Record<string, unknown>>; total: number; truncado: boolean }> {
  const tickets: Array<Record<string, unknown>> = [];
  let total = 0;

  for (let page = 1; page <= maxPaginas; page++) {
    const r = await client.searchTicketsPage(query, page);
    total = r.total ?? 0;
    const lote = (r.results || []) as unknown as Array<Record<string, unknown>>;
    tickets.push(...lote);
    if (lote.length < 30) break;
  }

  return { tickets, total, truncado: tickets.length < total };
}

/**
 * Mapa id -> nome de agente. Devolve null quando a conta nao tem permissao
 * (403), e nesse caso os relatorios seguem mostrando o ID em vez do nome.
 */
async function mapaAgentes(): Promise<Map<number, string> | null> {
  try {
    const agentes = (await client.listAgents({ per_page: 100 })) as unknown as Array<Record<string, unknown>>;
    const m = new Map<number, string>();
    for (const a of agentes) {
      const c = (a.contact as Record<string, unknown> | undefined) || a;
      m.set(a.id as number, (c.name as string) || (c.email as string) || String(a.id));
    }
    return m;
  } catch {
    return null;
  }
}

function nomeAgente(m: Map<number, string> | null, id: unknown): string {
  if (id === null || id === undefined) return '(sem responsavel)';
  return m?.get(id as number) || `id ${id}`;
}

function diasDesde(iso: unknown): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso as string).getTime()) / 86400000);
}

server.tool(
  'tickets_by_agent',
  'Distribuicao da carga: quantos chamados cada agente tem, quebrado por status. Responde "quantos chamados estao na mao de cada um". Inclui a linha de chamados sem responsavel.',
  {
    status: z
      .array(z.enum(STATUS_VALORES))
      .optional()
      .describe('Status a contar. Padrao: tudo que nao e Resolved nem Closed - inclui os status customizados do helpdesk, onde costuma estar o trabalho em curso'),
    group_id: z.number().optional().describe('Limita a um grupo'),
  },
  async ({ status, group_id }) => {
    try {
      const statusAlvo = (status || STATUS_ABERTOS.map(String)).map(Number);
      const filtroGrupo = group_id ? ` AND group_id:${group_id}` : '';
      const filtroStatus = `(${statusAlvo.map((s) => `status:${s}`).join(' OR ')})`;

      // Uma busca paginada em vez de uma contagem por agente/status: o cruzamento
      // agente x status sai da propria lista, e o caminho sem admin passa a ter as
      // mesmas colunas do caminho com admin - so muda o nome virar ID.
      const { tickets, total, truncado } = await coletar(`${filtroStatus}${filtroGrupo}`);

      if (tickets.length === 0) {
        return { content: [{ type: 'text', text: 'Nenhum chamado nos status pedidos.' }] };
      }

      const agentes = await mapaAgentes();
      const aviso = agentes
        ? ''
        : '\nSem permissao para listar agentes (403) - os agentes aparecem por ID.\n';

      // agente -> status -> quantidade
      const porAgente = new Map<string, Map<number, number>>();
      for (const t of tickets) {
        const k = nomeAgente(agentes, t.responder_id);
        if (!porAgente.has(k)) porAgente.set(k, new Map());
        const m = porAgente.get(k) as Map<number, number>;
        const s = t.status as number;
        m.set(s, (m.get(s) || 0) + 1);
      }

      // So as colunas que tem algum chamado, senao a tabela vira deserto de zeros.
      const colunas = statusAlvo.filter((s) => [...porAgente.values()].some((m) => m.get(s)));
      const larguras = colunas.map((s) => Math.max((STATUS_MAP[s] || String(s)).length, 5) + 2);

      const dados = [...porAgente.entries()]
        .map(([nome, m]) => ({
          nome,
          counts: colunas.map((s) => m.get(s) || 0),
          total: [...m.values()].reduce((a, b) => a + b, 0),
        }))
        .sort((a, b) => b.total - a.total);

      const cab =
        'Agente'.padEnd(32) +
        colunas.map((s, i) => (STATUS_MAP[s] || String(s)).padStart(larguras[i])).join('') +
        'Total'.padStart(7);

      const linhas = [cab, '-'.repeat(cab.length)];
      for (const d of dados) {
        linhas.push(
          d.nome.slice(0, 31).padEnd(32) +
            d.counts.map((c, i) => String(c).padStart(larguras[i])).join('') +
            String(d.total).padStart(7)
        );
      }

      // A linha "(sem responsavel)" ja esta na tabela, no mesmo recorte de status.
      // Nao repetir aqui um total de todos os status: dois numeros com o mesmo
      // rotulo e um convite a ler o errado.
      const rodape =
        `\n\nTotal nos status pedidos: ${total}` +
        (truncado ? '\nATENCAO: a busca trunca em 300 - os numeros acima podem estar subestimados.' : '');

      return { content: [{ type: 'text', text: `Distribuicao por agente${aviso}\n\n${linhas.join('\n')}${rodape}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

server.tool(
  'helpdesk_overview',
  'Retrato geral do helpdesk: totais por status e por prioridade, quantos estao sem responsavel e qual o chamado aberto mais antigo. Responde "quantos chamados temos no total".',
  {
    group_id: z.number().optional().describe('Limita a um grupo'),
  },
  async ({ group_id }) => {
    try {
      const f = group_id ? ` AND group_id:${group_id}` : '';
      const fSolo = group_id ? `group_id:${group_id}` : '';

      // Contagem por status, uma vez so - "em aberto" sai desta mesma conta em vez
      // de refazer as buscas.
      const contagem = new Map<number, number>();
      for (const s of TODOS_STATUS) {
        contagem.set(s, await contar(fSolo ? `status:${s}${f}` : `status:${s}`));
      }
      const totalGeral = [...contagem.values()].reduce((a, b) => a + b, 0);
      const abertos = STATUS_ABERTOS.reduce((soma, s) => soma + (contagem.get(s) || 0), 0);

      // Status customizado zerado nao merece uma linha; os quatro padrao ficam
      // sempre, mesmo em zero, porque a ausencia deles e informacao.
      const rotulo = Math.max(...TODOS_STATUS.map((s) => (STATUS_MAP[s] || String(s)).length));
      const porStatus = TODOS_STATUS.filter((s) => s <= 5 || (contagem.get(s) || 0) > 0).map(
        (s) => `  ${(STATUS_MAP[s] || String(s)).padEnd(rotulo)} ${String(contagem.get(s) || 0).padStart(6)}`
      );

      const porPrioridade: string[] = [];
      for (const p of [4, 3, 2, 1]) {
        const n = await contar(fSolo ? `priority:${p}${f}` : `priority:${p}`);
        porPrioridade.push(`  ${(PRIORITY_MAP[p] || String(p)).padEnd(rotulo)} ${String(n).padStart(6)}`);
      }

      // Sem responsavel so faz sentido no que ainda esta aberto: contando todos os
      // status, o numero e dominado por chamado fechado ha anos e nao serve para agir.
      const semResp = await contar(
        fSolo ? `agent_id:null AND ${filtroAbertos()} AND ${fSolo}` : `agent_id:null AND ${filtroAbertos()}`
      ).catch(() => -1);

      // o mais antigo ainda aberto
      let maisAntigo = '';
      try {
        const { tickets } = await coletar(fSolo ? `${filtroAbertos()} AND ${fSolo}` : filtroAbertos(), 10);
        if (tickets.length > 0) {
          const velho = tickets.reduce((a, b) =>
            new Date(a.created_at as string) < new Date(b.created_at as string) ? a : b
          );
          maisAntigo = `\nChamado aberto mais antigo: #${velho.id} - ${velho.subject} (${diasDesde(velho.created_at)} dias)`;
        }
      } catch { /* opcional */ }

      return {
        content: [
          {
            type: 'text',
            text: `Panorama do helpdesk${group_id ? ` (grupo ${group_id})` : ''}

Por status:
${porStatus.join('\n')}
  ${'TOTAL'.padEnd(rotulo)} ${String(totalGeral).padStart(6)}

Por prioridade:
${porPrioridade.join('\n')}

Em aberto (tudo menos Resolved/Closed): ${abertos}${semResp >= 0 ? `\nSem responsavel, em aberto: ${semResp}` : ''}${maisAntigo}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

server.tool(
  'agent_workload',
  'Overview completo dos chamados de um agente: a lista mais os agregados por status, prioridade e idade. Use quando quiser entender a carga de alguem, nao so contar.',
  {
    agent_id: z.number().describe('ID do agente. Use list_agents ou get_current_agent para descobrir'),
    only_open: z.boolean().optional().default(true).describe('So o que nao esta Resolved/Closed. False traz todos os status'),
  },
  async ({ agent_id, only_open }) => {
    try {
      const q =
        only_open !== false ? `agent_id:${agent_id} AND ${filtroAbertos()}` : `agent_id:${agent_id}`;
      const { tickets, total, truncado } = await coletar(q);

      if (tickets.length === 0) {
        return { content: [{ type: 'text', text: `Nenhum chamado para o agente ${agent_id}${only_open !== false ? ' em aberto' : ''}.` }] };
      }

      const porStatus = new Map<string, number>();
      const porPrioridade = new Map<string, number>();
      for (const t of tickets) {
        const s = STATUS_MAP[t.status as number] || String(t.status);
        const p = PRIORITY_MAP[t.priority as number] || String(t.priority);
        porStatus.set(s, (porStatus.get(s) || 0) + 1);
        porPrioridade.set(p, (porPrioridade.get(p) || 0) + 1);
      }

      const idades = tickets.map((t) => diasDesde(t.created_at));
      const media = Math.round(idades.reduce((a, b) => a + b, 0) / idades.length);

      const ordenados = [...tickets].sort((a, b) => diasDesde(b.updated_at) - diasDesde(a.updated_at));
      const lista = ordenados
        .map(
          (t) =>
            `  #${t.id} [${PRIORITY_MAP[t.priority as number]}] ${String(t.subject).slice(0, 60)}\n     ${STATUS_MAP[t.status as number]} | aberto ha ${diasDesde(t.created_at)}d | sem atualizacao ha ${diasDesde(t.updated_at)}d`
        )
        .join('\n');

      const parados = tickets.filter((t) => diasDesde(t.updated_at) > 7).length;

      return {
        content: [
          {
            type: 'text',
            text: `Carga do agente ${agent_id}: ${total} chamado(s)${truncado ? ' (lista truncada em 300 pelo limite da busca)' : ''}

Por status:     ${[...porStatus].map(([k, v]) => `${k}: ${v}`).join(' | ')}
Por prioridade: ${[...porPrioridade].map(([k, v]) => `${k}: ${v}`).join(' | ')}
Idade media:    ${media} dias
Sem atualizacao ha mais de 7 dias: ${parados}

Do mais parado para o mais recente:
${lista}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

server.tool(
  'stale_tickets',
  'Chamados que envelheceram: sem atualizacao ha mais de N dias, do mais parado para o menos. Mostra quem esta com cada um. Use para a revisao periodica da fila.',
  {
    days: z.number().optional().default(7).describe('Dias sem atualizacao. Padrao 7'),
    only_open: z.boolean().optional().default(true).describe('So o que nao esta Resolved/Closed'),
    only_assigned: z
      .boolean()
      .optional()
      .default(false)
      .describe('So os que tem responsavel. Use na revisao de fila: sem isso a lista costuma ser dominada por chamado antigo que nunca foi atribuido'),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe('Quantos exibir, do mais parado para o menos. Padrao 20. O total continua sendo reportado por inteiro'),
    group_id: z.number().optional(),
  },
  async ({ days, only_open, only_assigned, group_id, limit }) => {
    try {
      const dias = days || 7;
      const teto = limit && limit > 0 ? limit : 20;
      const limite = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
      const partes = [`updated_at:<'${limite}'`];
      if (only_open !== false) partes.push(filtroAbertos());
      if (group_id) partes.push(`group_id:${group_id}`);

      const busca = await coletar(partes.join(' AND '));
      const truncado = busca.truncado;
      // A busca do Freshdesk aceita `agent_id:null`, mas nao tem o inverso
      // (`agent_id:*` volta 400), entao "so com responsavel" se resolve na lista.
      const tickets = only_assigned ? busca.tickets.filter((t) => t.responder_id) : busca.tickets;
      const total = only_assigned ? tickets.length : busca.total;

      if (tickets.length === 0) {
        return { content: [{ type: 'text', text: `Nenhum chamado parado ha mais de ${dias} dias${only_assigned ? ' com responsavel' : ''}. Fila em dia.` }] };
      }

      const agentes = await mapaAgentes();
      const ordenados = [...tickets].sort((a, b) => diasDesde(b.updated_at) - diasDesde(a.updated_at));
      const exibidos = ordenados.slice(0, teto);

      const lista = exibidos
        .map(
          (t) =>
            `  ${String(diasDesde(t.updated_at)).padStart(4)}d  #${t.id} [${PRIORITY_MAP[t.priority as number]}] ${String(t.subject).slice(0, 55)}\n        ${STATUS_MAP[t.status as number] || t.status} | ${nomeAgente(agentes, t.responder_id)}`
        )
        .join('\n');

      // Dizer o que ficou de fora: uma lista cortada em silencio le-se como a lista inteira.
      const corte =
        ordenados.length > exibidos.length
          ? `\n\n  ... e mais ${ordenados.length - exibidos.length} - aumente o limit para ver o resto`
          : '';

      return {
        content: [
          {
            type: 'text',
            text: `${total} chamado(s) sem atualizacao ha mais de ${dias} dias${only_assigned ? ', com responsavel' : ''}${truncado ? ' (busca truncada em 300)' : ''}\n\n  dias  chamado\n${lista}${corte}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

server.tool(
  'team_summary',
  'Consolidado por grupo: quantos chamados abertos e pendentes cada grupo tem. Use quando o acompanhamento e por frente de trabalho, nao por pessoa.',
  {},
  async () => {
    try {
      let grupos: Array<Record<string, unknown>>;
      try {
        grupos = (await client.listGroups()) as unknown as Array<Record<string, unknown>>;
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: 'Sem permissao para listar grupos (403) - esta tool precisa de conta com acesso a administracao.\n\nAlternativa: se voce souber o group_id, use helpdesk_overview com group_id, que funciona com qualquer permissao.',
            },
          ],
        };
      }
      if (!grupos || grupos.length === 0) {
        return { content: [{ type: 'text', text: 'Nenhum grupo encontrado.' }] };
      }

      const linhas: string[] = [];
      linhas.push('Grupo'.padEnd(38) + 'Open'.padStart(7) + 'Pending'.padStart(9) + 'Total'.padStart(7));
      linhas.push('-'.repeat(61));

      const dados: Array<{ nome: string; o: number; p: number }> = [];
      for (const g of grupos) {
        const o = await contar(`group_id:${g.id} AND status:2`);
        const p = await contar(`group_id:${g.id} AND status:3`);
        if (o + p > 0) dados.push({ nome: (g.name as string) || `id ${g.id}`, o, p });
      }
      dados.sort((a, b) => b.o + b.p - (a.o + a.p));

      for (const d of dados) {
        linhas.push(
          d.nome.slice(0, 37).padEnd(38) + String(d.o).padStart(7) + String(d.p).padStart(9) + String(d.o + d.p).padStart(7)
        );
      }

      return { content: [{ type: 'text', text: `Chamados em aberto por grupo\n\n${linhas.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

// ==================== START SERVER ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Freshdesk MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
