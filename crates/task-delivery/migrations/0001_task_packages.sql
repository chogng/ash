CREATE TABLE IF NOT EXISTS task_delivery_packages (
    direction TEXT NOT NULL,
    id TEXT NOT NULL,
    owner TEXT NOT NULL,
    package TEXT NOT NULL,
    receipt TEXT,
    PRIMARY KEY(direction, id)
);
