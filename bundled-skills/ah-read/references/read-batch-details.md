# Read Batch Details

## Batch Strategy

- <=20 highlights: direct thematic batches
- >20 highlights: pre-cluster by topic/section

## Per-batch Output

- evidence snippets
- user interpretation
- 1-3 card candidates

## Progress Recording

Track:
- total batches
- completed batches
- next batch pointer

## Stop/Resume

If user stops mid-run:
- persist current batch index
- provide resume command hint

## Hand-off

When enough candidates exist, suggest `ah-card`.
