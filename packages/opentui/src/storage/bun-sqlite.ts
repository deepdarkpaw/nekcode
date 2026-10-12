/// <reference path="../../../../node_modules/bun-types/sqlite.d.ts" />
/**
 * Session databases through `bun:sqlite`. Bun's `node:sqlite` keeps a closed database's file open until its prepared
 * statements are garbage collected, so on Windows a session file could not be moved or deleted after use. This driver
 * finalizes its statements before closing, which releases the file at once.
 */

import { Database, type Statement } from "bun:sqlite";
import type { SqliteDriver } from "@earendil-works/pi-coding-agent/core/durable/sqlite";

export const bunSqliteDriver: SqliteDriver = {
	open(path, options) {
		const db = new Database(path, options.readOnly === true ? { readonly: true } : { create: true, readwrite: true });
		const statements: Statement[] = [];
		db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs)}`);
		return {
			exec: (sql) => {
				db.exec(sql);
			},
			prepare: (sql) => {
				const statement = db.prepare(sql);
				statements.push(statement);
				return {
					run: (...params) => statement.run(...params),
					// `bun:sqlite` returns null for no row; `node:sqlite` returns undefined.
					get: (...params) => statement.get(...params) ?? undefined,
					all: (...params) => statement.all(...params),
				};
			},
			close: () => {
				for (const statement of statements.splice(0)) statement.finalize();
				db.close();
			},
		};
	},
};
