/// <reference path="../../../../node_modules/bun-types/sqlite.d.ts" />
/**
 * Session databases through `bun:sqlite`. Bun's `node:sqlite` retains prepared-statement file handles after close,
 * preventing Windows session databases from being moved or deleted. Finalize every statement before closing.
 */
import { Database, type Statement } from "bun:sqlite";
import type { SqliteDriver } from "../core/durable/sqlite.ts";

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
