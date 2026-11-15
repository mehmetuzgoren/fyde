import Foundation

/// Related visual terms used when searching metadata from an existing local index.
enum MediaTermMatcher {
    private static let groups = [
        ["kayak", "kayaking", "kayaker", "canoe", "canoeing", "raft", "rafting", "paddle", "paddling", "whitewater"],
        ["bike", "biking", "bicycle", "bicycling", "cycle", "cycling"],
        ["hike", "hiking", "trek", "trekking"],
        ["cat", "kitten", "feline"],
        ["dog", "puppy", "canine"],
        ["sunset", "sundown", "dusk"]
    ].map { Set($0.map(stem)) }

    private static let stopWords: Set<String> = [
        "the", "and", "for", "with", "from", "all", "both", "my", "our", "your", "his", "her", "their", "me", "us",
        "file", "files", "photo", "photos", "picture", "pictures", "pic", "pics", "image", "images", "video", "videos",
        "clip", "clips", "document", "documents", "doc", "docs", "send", "get", "find", "show", "search",
        "in", "of", "to", "a", "an", "on", "at", "is", "are", "was", "that", "this", "those", "these", "some",
        "any", "please", "where", "when", "what", "which", "one", "ones"
    ]

    static func coverage(query: String, text: String) -> Double {
        let words = Set(tokens(text).map(stem))
        let terms = Set(tokens(query).filter { !stopWords.contains($0) }.map(stem))
        guard !terms.isEmpty else { return 0 }
        let matched = terms.reduce(0.0) { score, term in
            if words.contains(term) { return score + 1 }
            if groups.contains(where: { $0.contains(term) && !$0.isDisjoint(with: words) }) {
                return score + 0.75
            }
            return score
        }
        return matched / Double(terms.count)
    }

    private static func tokens(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    private static func stem(_ word: String) -> String {
        if word.count > 5 && word.hasSuffix("ing") { return String(word.dropLast(3)) }
        if word.count > 4 && word.hasSuffix("ies") { return String(word.dropLast(3)) + "y" }
        if word.count > 3 && word.range(of: "(sh|ch|x|z|ss)es$", options: .regularExpression) != nil {
            return String(word.dropLast(2))
        }
        if word.count > 3 && word.hasSuffix("s") && !word.hasSuffix("ss") { return String(word.dropLast()) }
        return word
    }
}
