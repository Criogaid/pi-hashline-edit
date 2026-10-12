# Regex translation sources and notices

The JS-to-ripgrep candidate translator adapts the following analysis techniques to this project's byte-preserving reads and JavaScript final verification. These projects are references, not runtime dependencies. Unicode membership comes from the running JavaScript engine rather than copied Unicode tables.

| Project | Technique used here | Source license |
| --- | --- | --- |
| [regexpu-core](https://github.com/mathiasbynens/regexpu-core) | Separate scalar sets from class strings; apply scoped flags before lowering a set | MIT |
| [refa](https://github.com/RunDevelopment/refa/tree/8d20d94232b1adb043c29810046c060ca1664bf1) | Normalized character intervals and bounded finite languages | MIT |
| [regexp-ast-analysis](https://github.com/RunDevelopment/regexp-ast-analysis/tree/6f0dbfc42ccc4a3fd22da6e3917f4e8cef07bee8) | Track exactness and fixed-width neighbouring characters across assertions | MIT |
| [eslint-plugin-regexp](https://github.com/ota-meshi/eslint-plugin-regexp/tree/4700804dba99bed531e727f09c72a69a1dc939a4) | Character constraints for lookarounds and word boundaries | MIT |
| [regex-syntax](https://github.com/rust-lang/regex/blob/master/regex-syntax/src/hir/literal.rs) | Budget literal expansion; retain necessary prefixes and suffixes without dropping alternatives | MIT OR Apache-2.0 |
| [RE2](https://github.com/google/re2/blob/main/re2/prefilter.cc) | Necessary AND/OR literal conditions for file prefiltering | BSD-3-Clause |
| [Vectorscan](https://github.com/VectorCamp/vectorscan/blob/develop/src/parser/prefilter.cpp) | Widen unsupported assertions and backreferences while retaining regular constraints | BSD-3-Clause |

Production implementations live in `src/core/character-set.ts`, `src/core/search-analysis.ts`, `src/core/case-fold.ts`, `src/pi/rg-regex.ts`, and `src/pi/rg-process.ts`. In particular, this project does not copy an automaton engine, a Unicode version table, or upstream match semantics into its final verifier.

## MIT reference projects

regexpu-core: Copyright Mathias Bynens <https://mathiasbynens.be/>

refa: Copyright (c) 2020 Michael Schmidt

regexp-ast-analysis: Copyright (c) 2021 Michael Schmidt

eslint-plugin-regexp: Copyright (c) 2020 Yosuke Ota

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Test262 regression witnesses

`src/testing/regex-translation-corpus.ts` adapts selected patterns and witnesses from [Test262](https://github.com/tc39/test262). Each fixture identifies its upstream test file. The local assertions check candidate-line inclusion and final JS results rather than reproducing the Test262 harness.

Copyright 2022 Igalia S.L. All rights reserved.

Copyright (C) 2017 the V8 project authors. All rights reserved.

Copyright 2025 Mathias Bynens. All rights reserved.

Test262: ECMAScript Test Suite ("Software") is protected by copyright and is being
made available under the "BSD License", included below. This Software may be subject to third party rights (rights
from parties other than Ecma International), including patent rights, and no licenses under such third party rights
are granted under this license even if the third party concerned is a member of Ecma International. SEE THE ECMA
CODE OF CONDUCT IN PATENT MATTERS AVAILABLE AT https://www.ecma-international.org/ipr FOR
INFORMATION REGARDING THE LICENSING OF PATENT CLAIMS THAT ARE REQUIRED TO IMPLEMENT ECMA INTERNATIONAL STANDARDS*.

Copyright (C) 2012 Ecma International
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the authors nor Ecma International may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE ECMA INTERNATIONAL "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT
SHALL ECMA INTERNATIONAL BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

* Ecma International Standards hereafter means Ecma International Standards as well as Ecma Technical Reports
