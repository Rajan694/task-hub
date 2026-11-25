.PHONY: build test clean

VERSION := 1.0
export PATH := $(PATH)

build: ## Build the app
	@echo building

test: build ## Run the tests
	@echo testing

%.o: %.c
	cc -c $<

clean:
	rm -rf out
