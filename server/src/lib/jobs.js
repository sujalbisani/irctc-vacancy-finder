const crypto = require('crypto');

const JOB_TTL_MS = 15 * 60 * 1000; // keep finished jobs around long enough for the client to poll them
const jobs = new Map();

function createJob(initial) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'running', createdAt: Date.now(), ...initial };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    jobs.delete(id);
    return null;
  }
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

// Periodic sweep so long-lived processes don't accumulate stale jobs forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60 * 1000).unref();

module.exports = { createJob, getJob, updateJob };
