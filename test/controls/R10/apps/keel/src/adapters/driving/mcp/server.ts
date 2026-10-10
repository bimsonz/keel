// Control for R10: Keel's control plane imports an agent runtime and an MCP client.
import { Agent } from "agents";
import { Client } from "@modelcontextprotocol/client";

export const bad = [Agent, Client];
