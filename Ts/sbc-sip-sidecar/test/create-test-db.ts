import test from 'tape';
import { exec } from 'node:child_process';
import path from 'node:path';

test('creating jambones_test database', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp < ${path.join(__dirname, 'db', 'create_test_db.sql')}`, (err) => {
    if (err) return t.end(err);
    t.pass('database successfully created');
    t.end();
  });
});

test('creating schema', (t) => {
  exec(
    `mysql -h 127.0.0.1 -u root --protocol=tcp -D jambones_test < ${path.join(__dirname, 'db', 'jambones-sql.sql')}`,
    (err) => {
      if (err) return t.end(err);
      t.pass('schema successfully created');
      t.end();
    }
  );
});

test('populating test case data', (t) => {
  exec(
    `mysql -h 127.0.0.1 -u root --protocol=tcp -D jambones_test < ${path.join(__dirname, 'db', 'populate-test-data.sql')}`,
    (err) => {
      if (err) return t.end(err);
      t.pass('test data set created');
      t.end();
    }
  );
});
