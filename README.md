# Ni Airlines · AI travel planner

A conversational travel-planning demo with English and Traditional Chinese
interfaces, personalized trip suggestions, flight comparisons, and optional
voice conversations.

**Ni Airlines is a fictional demo brand, not an official airline service.**
Flight schedules, availability, and fares are synthetic demonstration data.

## What it does

- Plan itineraries around destinations, dates, budgets, cabin choices, and
  travel preferences.
- Search and compare sample flights, select an option, and review an updated
  quote before simulated checkout.
- Explore personalized suggestions with fictional member profiles. Explicit
  trip choices take priority over profile preferences, and the profile city
  requires confirmation before use as a departure city.
- Talk to the assistant through configurable Azure voice integrations.
- Run locally in mock mode without Azure credentials.

The travel flow is **Discover → Plan → Search → Compare → Select → Reprice →
simulated checkout**. No real reservations, ticket issuance, or payments are
performed. Do not enter passport or payment-card information.

## Four collaborating agents

| Agent | Role |
|---|---|
| Intent | Understand the request and clarify missing details |
| Travel planner | Suggest itineraries using preferences and approved knowledge |
| Flight checker | Search and compare sample flights |
| Price and purchase | Review offers and guide simulated checkout |

The agents share the same trip context. Flight and price tools are also exposed
through an MCP server. Optional Microsoft Foundry and Azure voice integrations
connect the local application to configured cloud services.

## Explore the repository

| Folder | Contents |
|---|---|
| `public` | Web chat interface |
| `lib` | Travel agents, trip logic, tools, and integrations |
| `data` | Synthetic flight data and fictional member profiles |
| `staging/member-public` | Bilingual member interface |
| `tests` | Application and browser tests |
| `docs` | Setup and technical guides |

## Guides

- [Setup and configuration](docs/FOUNDRY.md)
- [System design](docs/SYSTEM-DESIGN.md)
- [Demo walkthrough](docs/DEMO-SCRIPT.md)
- [Voice integration comparison](docs/VOICE-COMPARISON.md)

Mock mode is local and offline. Cloud integrations require configuration and may
incur charges. Sample inventory is not a complete or current airline network.
