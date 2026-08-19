# Freshdesk MCP Server

> **This is a fork** of [NeuraLegion/freshdesk_mcp](https://github.com/NeuraLegion/freshdesk_mcp), originally developed and maintained by [Bright Security](https://brightsec.com), MIT licensed. All the original work and credit is theirs — see the section below for what this fork adds.

An MCP (Model Context Protocol) server for integrating with the Freshdesk API. Provides tools for managing support tickets, contacts, companies, and more.

## What this fork adds

Three gaps that showed up while working real support tickets:

### Custom fields on `update_ticket`

Many helpdesks require custom fields to change a ticket's status. Without them the API rejects the call with `Validation failed / missing_field`, and there was no way to send them — the tool schema didn't expose `custom_fields`, even though the client already supported it.

```
update_ticket · ticket_id: 123 · status: "4"
  custom_fields: { "cf_estimated_deadline": "2026-08-19", "cf_estimated_hours": 4 }
```

### `view_ticket` resolves names, shows custom fields, and can return HTML

It used to print raw IDs (`Requester ID: 101056340013`) and read `description_text`, which **silently drops images pasted into the ticket body**. On a real ticket the text field held 200 characters while the HTML held 2979 — the missing part was a screenshot the requester had pasted inline.

- **Requester name** resolved through the API's own `include=requester`. This matters on restricted-permission accounts: `viewContact` returns 404 when the requester is an agent, and `viewAgent` returns 403 without permission. The `include` works in both cases.
- **Assigned agent** resolved when permission allows; when it doesn't, falls back to `/agents/me` to detect "it's you", and otherwise says so explicitly instead of showing a bare number.
- **Custom fields** listed.
- **`include_html`** returns the raw HTML description, where the `<img>` tags live.

### Attachments — including inline images

Two new tools:

- **`get_ticket_attachments`** — finds both formal attachments and images pasted into the email body (`<img src>`), across the description *and* the conversations.
- **`download_ticket_attachment`** — downloads to a local file, so the image can actually be opened and read.

Downloads try unauthenticated first (attachment URLs are pre-signed and often point at S3) and only send the auth header when the host belongs to Freshdesk — so credentials never leak to a third-party host.

> **Disclaimer:** This software is provided as-is by Bright Security. Use at your own risk. Bright Security makes no warranties regarding the reliability, accuracy, or completeness of this tool. You are solely responsible for how you use it and for any actions performed through the Freshdesk API. Always review tool actions before executing them in production environments.

## Setup

### 1. Get Your Freshdesk API Key

1. Log in to your Freshdesk account
2. Click on your profile picture → Profile Settings
3. Your API key is displayed on the right side

### 2. Configure Environment Variables

```bash
export FRESHDESK_DOMAIN=yourcompany      # Your subdomain (from yourcompany.freshdesk.com)
export FRESHDESK_API_KEY=your_api_key    # Your API key
```

### 3. Build

```bash
npm install
npm run build
```

### 4. Add to Claude/VSCode Configuration

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": ["/path/to/freshdesk_mcp/dist/index.js"],
      "env": {
        "FRESHDESK_DOMAIN": "yourcompany",
        "FRESHDESK_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Available Tools (48 total)

Tools marked **★** are additions in this fork.

### Tickets (5)
| Tool | Description |
|------|-------------|
| `list_tickets` | List tickets with filters (status, priority, requester, date) |
| `view_ticket` | View a ticket. **★** Resolves requester/agent names, shows custom fields, and `include_html` returns the raw HTML where inline images live |
| `create_ticket` | Create a new support ticket |
| `search_tickets` | Search tickets using Freshdesk query syntax |
| `update_ticket` | Update ticket properties. **★** Now accepts `custom_fields`, required by many helpdesks to change status |

### Attachments ★ (2)
| Tool | Description |
|------|-------------|
| `get_ticket_attachments` | **★** Lists formal attachments **and** images pasted inline in the email body, across the description and conversations |
| `download_ticket_attachment` | **★** Downloads an attachment or inline image to a local file, so it can be opened and read |

### Reporting ★ (5)
For team leads: who is carrying what, and what has gone stale.

| Tool | Description |
|------|-------------|
| `tickets_by_agent` | **★** Load distribution per agent, broken down by status. Includes the unassigned count |
| `helpdesk_overview` | **★** Totals by status and priority, unassigned count, oldest open ticket |
| `agent_workload` | **★** One agent's full list plus aggregates: by status, by priority, average age, how many are stale |
| `stale_tickets` | **★** Tickets with no update in N days, oldest first, with who holds each |
| `team_summary` | **★** Open and pending per group |

Counting is cheap: the Freshdesk search endpoint returns a complete `total` on any page, so these tools read the count without paginating. Listing is capped at 300 results (30 per page × 10 pages) — when a list is truncated, the output says so rather than reporting a smaller number silently.

**Restricted-permission accounts:** `list_agents` and `list_groups` return 403 for non-admin accounts. `tickets_by_agent` detects this and falls back to aggregating by `responder_id` from the tickets themselves — the numbers stay correct, agents show as IDs instead of names. `team_summary` requires admin and says so explicitly.

### Conversations (3)
| Tool | Description |
|------|-------------|
| `list_ticket_conversations` | Get all replies and notes for a ticket |
| `reply_to_ticket` | Send a public reply (emails the customer) |
| `add_note_to_ticket` | Add a private or public note |

### Contacts (5)
| Tool | Description |
|------|-------------|
| `list_contacts` | List contacts |
| `view_contact` | View contact details |
| `search_contacts` | Search contacts |
| `create_contact` | Create a contact |
| `update_contact` | Update a contact |

### Agents (3)
| Tool | Description |
|------|-------------|
| `list_agents` | List agents (admin only) |
| `view_agent` | View an agent (admin only) |
| `get_current_agent` | The authenticated agent — works without admin |

### Groups (2)
| Tool | Description |
|------|-------------|
| `list_groups` | List groups (admin only) |
| `view_group` | View a group |

### Companies (5)
| Tool | Description |
|------|-------------|
| `list_companies` | List companies |
| `view_company` | View company details |
| `create_company` | Create a company |
| `update_company` | Update a company |
| `search_companies` | Search companies |

### Time Tracking (3)
| Tool | Description |
|------|-------------|
| `list_time_entries` | List time entries |
| `create_time_entry` | Log time on a ticket |
| `toggle_timer` | Start/stop a timer |

### Canned Responses (3)
| Tool | Description |
|------|-------------|
| `list_canned_response_folders` | List folders |
| `list_canned_responses` | List responses in a folder |
| `view_canned_response` | View a response |

### Knowledge Base (5)
| Tool | Description |
|------|-------------|
| `list_solution_categories` | List categories |
| `list_solution_folders` | List folders in a category |
| `list_solution_articles` | List articles in a folder |
| `view_solution_article` | View an article |
| `search_solutions` | Search the knowledge base |

### Satisfaction Ratings (2)
| Tool | Description |
|------|-------------|
| `list_ticket_satisfaction_ratings` | Ratings for one ticket |
| `list_all_satisfaction_ratings` | All ratings |

### Configuration (5)
| Tool | Description |
|------|-------------|
| `list_ticket_fields` | Ticket fields, including the `cf_*` custom fields your account requires |
| `list_products` | List products |
| `list_business_hours` | List business hours |
| `list_sla_policies` | List SLA policies |
| `list_roles` | List roles |

> Tip: run `list_ticket_fields` once to discover which `cf_*` fields your helpdesk marks as required. Those are the ones `update_ticket` needs when changing status.

## Search Query Syntax

The search tools use Freshdesk's query syntax:

### Ticket Search
- `status:2` - Open, `status:3` - Pending, `status:4` - Resolved, `status:5` - Closed
- `priority:1` - Low, `priority:2` - Medium, `priority:3` - High, `priority:4` - Urgent
- `agent_id:123` - Assigned to agent
- `group_id:456` - In group
- `tag:'billing'` - Has tag
- `created_at:>'2024-01-01'` - Created after date

### Contact Search
- `email:john@example.com`
- `name:John`
- `phone:123456`

### Company Search
- `name:Acme`
- `domain:acme.com`

### Combine with AND/OR
- `(status:2 OR status:3) AND priority:4`

## Usage Examples

```
# List open tickets
list_tickets with filter "new_and_my_open"

# Search urgent tickets
search_tickets with query "priority:4"

# Create a ticket
create_ticket with subject "Login issue", description "Cannot log in", email "customer@example.com"

# Reply to customer
reply_to_ticket with ticket_id 12345, body "We're looking into this"

# Add internal note
add_note_to_ticket with ticket_id 12345, body "Escalated to engineering", private true

# Log time
create_time_entry with ticket_id 12345, time_spent "01:30", note "Investigated issue"

# Search knowledge base
search_solutions with query "password reset"
```

### This fork

```
# Close a ticket that requires custom fields
update_ticket with ticket_id 61726, status "4",
  custom_fields { "cf_estimated_deadline": "2026-08-19", "cf_estimated_hours": 4 }

# Read a ticket whose text looks truncated — the rest is an inline image
view_ticket with ticket_id 61726, include_html true

# Find and download a screenshot pasted into the ticket
get_ticket_attachments with ticket_id 61726
download_ticket_attachment with url "<url from above>", out_path "C:/temp/print.png"

# Who is carrying what
tickets_by_agent

# What has gone stale
stale_tickets with days 30

# One person's full load
agent_workload with agent_id 101158193535
```

## Development

```bash
git clone https://github.com/gaudenciobruno96/freshdesk-mcp.git
cd freshdesk-mcp
npm install
npm run build
npm start
```

Upstream is [NeuraLegion/freshdesk_mcp](https://github.com/NeuraLegion/freshdesk_mcp) — pull their updates with `git fetch upstream && git merge upstream/main`.

## License

MIT. Copyright (c) 2026 Bright Security. See [LICENSE](LICENSE) for details.
