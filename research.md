# Research Draft: Computational Proof of AI Execution

**Status:** Working draft  
**Topic:** Proving that an AI system performed a requested action — at the computational level — rather than relying on trust in the model's probabilistic outputs.  
**Core question:** If we cannot fully trust AI because it is probabilistic, can we build mechanisms to *verifiably prove* what it did?

---

## 1. Problem Statement

Large language models and AI agents are fundamentally probabilistic. They predict tokens, sample from distributions, and can hallucinate, skip steps, or produce plausible-sounding but incorrect results. Because of this, we generally cannot *trust* an AI to faithfully execute a request — we can only hope it did.

This research does not aim to make AI trustworthy in the sense of being reliable or truthful. Instead, it asks:

> Can we create computational evidence — a proof, receipt, or attestation — that an AI system actually performed the specific action or computation it was asked to do?

This shifts the burden from **trust** (belief) to **verifiability** (evidence).

---

## 2. Core Concept

| Dimension | Trust-Based Model | Proof-Based Model |
|-----------|-------------------|-------------------|
| Assumption | "The AI probably did what I asked." | "Here is computational evidence that it did." |
| Basis | Model reputation, benchmarks, human review | Logs, attestations, cryptographic proofs, reproducible execution |
| Failure mode | Silent hallucination, skipped tool calls | Missing/invalid proof = action not verified |
| User question | "Did it work?" | "Show me the receipt." |

**Goal:** A system where every AI action is accompanied by a computational artifact that can be independently verified.

---

## 3. Candidate Approaches

### 3.1 Trusted Execution Environments (TEEs)
Run AI inference inside a hardware-enforced enclave (e.g., Intel SGX, AMD SEV, ARM TrustZone). The enclave produces a signed attestation proving:
- The model code ran unchanged
- The input was exactly what the user provided
- The output came from that specific run

**Pros:** Hardware-backed, tamper-resistant.  
**Cons:** Requires specific hardware, model must fit in enclave, performance overhead.

### 3.2 Zero-Knowledge Machine Learning (zkML)
Generate a zero-knowledge proof that a specific model inference was run correctly on a specific input, without revealing model weights or internal computation.

**Pros:** Cryptographic proof, privacy-preserving.  
**Cons:** Extremely computationally expensive for large models, early-stage technology.

### 3.3 Tamper-Evident Audit Logs
Append-only, cryptographically chained logs (hash-linked or blockchain-based) recording every tool call, API request, prompt, and response with timestamps and signatures.

**Pros:** Practical today, low overhead.  
**Cons:** Proves *that something was logged*, not necessarily that the AI executed correctly (log could be falsified unless combined with signing/TEE).

### 3.4 Deterministic / Reproducible Execution
Pin model versions, temperature = 0, fixed seeds, and record exact inputs/outputs. Anyone can re-run and compare.

**Pros:** Simple to understand.  
**Cons:** Most LLMs are not truly deterministic; API providers may change models under the hood; does not prove a past run happened.

### 3.5 Output Watermarking / Fingerprinting
Embed invisible signals in model outputs that can later be verified as originating from a specific model run or provider.

**Pros:** Lightweight.  
**Cons:** Can be removed or forged; proves origin, not execution fidelity.

---

## 4. Research Questions

1. What is the minimal viable "computational receipt" for an AI agent action?
2. Which combination of TEE + logging + zkML provides the best tradeoff between verifiability and performance?
3. How do we prove *tool use* (e.g., "the AI actually called this API and used the result") rather than just text generation?
4. What legal or regulatory standards might require computational proof of AI actions (e.g., in healthcare, finance, legal)?
5. How do we handle multi-agent systems where Agent A delegates to Agent B?

---

## 5. Potential Use Cases

- **AI agents handling money:** Prove the agent initiated the exact transfer requested, not a different one.
- **Autonomous coding agents:** Prove the agent ran the test suite and all tests passed before claiming completion.
- **Customer support bots:** Prove the agent retrieved the correct policy document and did not fabricate a refund promise.
- **Scientific AI:** Reproducible proof that a drug-discovery model screened specific molecules.
- **Regulated industries:** Auditable trail showing an AI did not access unauthorized data.

---

## 6. Challenges & Open Problems

- **Performance:** Cryptographic proofs for large models are slow.
- **API opacity:** Third-party model providers may not expose internals needed for proof.
- **Non-determinism:** Sampling, floating-point differences, and updates break reproducibility.
- **Usability:** Users don't want to read raw logs; proofs need human-interpretable summaries.
- **Adversarial logging:** A malicious agent could log fake actions unless the environment is attested.

---

## 7. Next Steps / Outline for Deeper Research

- [ ] Survey existing TEE-based AI inference projects
- [ ] Benchmark zkML prover performance for small transformer models
- [ ] Design a "receipt" schema (input hash, model ID, version, timestamp, tool calls, output hash, signature)
- [ ] Prototype a logging middleware for AI agents
- [ ] Define threat model: what exactly are we proving, and against whom?

---

## 8. References & Sources (placeholder)

- Trusted Execution Environments for ML inference
- zkML / zero-knowledge machine learning literature
- AI audit trail and provenance standards
- Model watermarking and fingerprinting research

---

> **Working hypothesis:** Trust is the wrong target for probabilistic AI. The more tractable goal is *computational accountability* — building systems where an AI's actions leave verifiable, inspectable evidence that can be checked without trusting the model itself.
